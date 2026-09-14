/**
 * The relay: how a browser anywhere reaches the panel on somebody's Mac.
 *
 * The panel opens a WebSocket to this service (GET /relay/connect, with its
 * device bearer) and keeps it open. Each claimed device has one of these
 * Durable Objects, found by the device id, and it holds that socket. When a
 * browser asks for /p/<device>/anything, the Worker checks that the person
 * signed in owns the device (relay.ts) and hands the request to this object,
 * which sends it down the socket as a JSON frame and waits for the panel's
 * answer. The panel side is intake/relay.py in the LectureAI repo.
 *
 * Frames, all JSON text:
 *
 *   to the panel     {t:"req", id, method, path, query, headers, viewer:{email, account_id}, base, body}
 *   from the panel   {t:"res", id, status, headers, body, more?}   then   {t:"chunk", id, body, more?}
 *                    {t:"hello", name?, version?}   once, on connect; informational
 *
 * Bodies are base64. A message may not exceed 1 MiB on Cloudflare, so the
 * panel splits a long response into chunks; the whole is capped here.
 *
 * With no socket, or a socket that does not answer, the browser gets a page
 * saying the Mac is not connected rather than a timeout. The object sleeps
 * (hibernates) between messages; pings from the panel are answered without
 * waking it.
 */

import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "./env";
import { panelNotConnectedPage } from "./pages";
import { fromBase64, now, randomId, toBase64 } from "./util";

/** How long a relayed request may wait for the panel before it is a 504 and the socket is presumed dead. */
export const REQUEST_TIMEOUT_MS = 25_000;
/** The most a panel response may add up to, across chunks. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** The most a browser may send to the panel. The panel's forms are small JSON. */
export const MAX_BODY_BYTES = 64 * 1024;
/** What the panel should split responses at. Told to the panel in the welcome frame. */
export const CHUNK_BYTES = 256 * 1024;

/** Request headers worth carrying to the panel. Cookies never are. */
export const REQUEST_HEADERS = ["content-type", "accept", "accept-language", "if-none-match", "if-modified-since"];
/** Response headers worth carrying back. */
const RESPONSE_HEADERS = new Set(["content-type", "cache-control", "etag", "last-modified", "location", "vary", "content-language"]);

export type ReqFrame = {
  t: "req";
  id: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  viewer: { email: string; account_id: string };
  base: string;
  body: string;
};
export type ResFrame = { t: "res"; id: string; status: number; headers?: Record<string, string>; body?: string; more?: boolean };
export type ChunkFrame = { t: "chunk"; id: string; body?: string; more?: boolean };
export type HelloFrame = { t: "hello"; name?: string; version?: string };
export type WelcomeFrame = { t: "welcome"; device: string; chunk_bytes: number; max_response_bytes: number; timeout_ms: number };

type Pending = {
  status: number;
  headers: Record<string, string>;
  parts: Uint8Array[];
  size: number;
  resolve: (r: Response) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** What survives hibernation and restarts: when the panel was last here. */
export type RelayState = {
  name: string;
  connected_at: string;
  disconnected_at: string;
};

const EMPTY: RelayState = { name: "", connected_at: "", disconnected_at: "" };

export class PanelRelay extends DurableObject<Bindings> {
  private pending = new Map<string, Pending>();

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    // The panel pings to keep NATs and sleepy links honest; answer without waking.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private async state(): Promise<RelayState> {
    return (await this.ctx.storage.get<RelayState>("state")) ?? EMPTY;
  }

  private async update(patch: Partial<RelayState>): Promise<void> {
    await this.ctx.storage.put("state", { ...(await this.state()), ...patch });
  }

  private panel(): WebSocket | null {
    return this.ctx.getWebSockets("panel")[0] ?? null;
  }

  /** For the account page and the panel's own Setup page: is the Mac here right now. */
  async describe(): Promise<RelayState & { connected: boolean }> {
    return { ...(await this.state()), connected: this.panel() !== null };
  }

  async fetch(request: Request): Promise<Response> {
    const op = request.headers.get("X-Relay-Op") ?? "";
    if (op === "connect") return this.acceptPanel(request);
    if (op === "state") return Response.json(await this.describe());
    return this.relay(request);
  }

  // --- The panel's socket -------------------------------------------------------

  private async acceptPanel(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket", { status: 426 });
    }
    const name = request.headers.get("X-Relay-Device-Name") ?? "";
    const deviceId = request.headers.get("X-Relay-Device") ?? "";
    // One panel per device. A restarted panel arrives before the old
    // socket has noticed it is dead; the newer one is the live one.
    for (const old of this.ctx.getWebSockets("panel")) old.close(1000, "replaced by a newer connection from the panel");
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["panel"]);
    await this.update({ name, connected_at: now(), disconnected_at: "" });
    const welcome: WelcomeFrame = {
      t: "welcome",
      device: deviceId,
      chunk_bytes: CHUNK_BYTES,
      max_response_bytes: MAX_RESPONSE_BYTES,
      timeout_ms: REQUEST_TIMEOUT_MS,
    };
    server.send(JSON.stringify(welcome));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let frame: ResFrame | ChunkFrame | HelloFrame;
    try {
      frame = JSON.parse(message) as ResFrame | ChunkFrame | HelloFrame;
    } catch {
      return;
    }
    if (frame.t === "hello") {
      if (frame.name) await this.update({ name: String(frame.name).slice(0, 80) });
      return;
    }
    if (frame.t !== "res" && frame.t !== "chunk") return;
    const p = this.pending.get(frame.id);
    if (!p) return; // answered late, after the timeout; nothing to give it to
    if (frame.t === "res") {
      p.status = Number(frame.status) || 502;
      p.headers = frame.headers ?? {};
    }
    if (frame.body) {
      const bytes = fromBase64(frame.body);
      p.size += bytes.length;
      p.parts.push(bytes);
    }
    if (p.size > MAX_RESPONSE_BYTES) {
      this.finish(frame.id, new Response("The panel's answer was too large to relay.", { status: 502 }));
      return;
    }
    if (frame.more) return;
    this.finish(frame.id, this.assemble(p));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _clean: boolean): Promise<void> {
    await this.gone(ws, `closed (${code}${reason ? ` ${reason}` : ""})`);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.gone(ws, `error: ${error instanceof Error ? error.message : String(error)}`);
  }

  private async gone(ws: WebSocket, why: string): Promise<void> {
    try {
      ws.close(1000, "bye");
    } catch {
      /* already closed */
    }
    if (this.panel() !== null) return; // replaced, not gone
    console.log(`panel socket ${why}`);
    await this.update({ disconnected_at: now() });
    const state = await this.state();
    for (const id of [...this.pending.keys()]) this.finish(id, this.notConnected(state, "/api/"));
  }

  // --- A browser's request ------------------------------------------------------

  private async relay(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ws = this.panel();
    if (!ws) return this.notConnected(await this.state(), url.pathname);
    const id = randomId(9);
    const headers: Record<string, string> = {};
    for (const name of REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }
    const raw = request.method === "GET" || request.method === "HEAD" ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
    if (raw.length > MAX_BODY_BYTES) return new Response("Request body too large.", { status: 413 });
    const frame: ReqFrame = {
      t: "req",
      id,
      method: request.method,
      path: url.pathname,
      query: url.search.slice(1),
      headers,
      viewer: {
        email: request.headers.get("X-Relay-Viewer-Email") ?? "",
        account_id: request.headers.get("X-Relay-Viewer-Account") ?? "",
      },
      base: request.headers.get("X-Relay-Base") ?? "",
      body: raw.length ? toBase64(raw) : "",
    };
    const answer = new Promise<Response>((resolve) => {
      const timer = setTimeout(() => void this.timedOut(id, ws), REQUEST_TIMEOUT_MS);
      this.pending.set(id, { status: 0, headers: {}, parts: [], size: 0, resolve, timer });
    });
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      const p = this.pending.get(id);
      if (p) clearTimeout(p.timer);
      this.pending.delete(id);
      console.log(`could not send to the panel: ${err instanceof Error ? err.message : String(err)}`);
      return this.notConnected(await this.state(), url.pathname);
    }
    return answer;
  }

  /** The Mac did not answer in time: it has probably gone to sleep with the socket half open. */
  private async timedOut(id: string, ws: WebSocket): Promise<void> {
    if (!this.pending.has(id)) return;
    console.log(`panel did not answer request ${id} in ${REQUEST_TIMEOUT_MS} ms; closing its socket`);
    this.finish(
      id,
      new Response("The Mac running this Syllabus did not answer. It may have gone to sleep. Try again in a moment.", {
        status: 504,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );
    try {
      ws.close(1011, "no answer to a relayed request");
    } catch {
      /* already gone */
    }
    await this.gone(ws, "presumed dead after a timeout");
  }

  private finish(id: string, response: Response): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(response);
  }

  private assemble(p: Pending): Response {
    const headers = new Headers();
    for (const [name, value] of Object.entries(p.headers)) {
      if (RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    }
    headers.set("Cache-Control", headers.get("Cache-Control") ?? "no-store");
    const body = p.status === 204 || p.status === 304 ? null : concat(p.parts, p.size);
    return new Response(body, { status: p.status, headers });
  }

  private notConnected(state: RelayState, path: string): Response {
    if (path.startsWith("/api/")) {
      return Response.json(
        { error: `${state.name || "That Mac"} is not connected`, relay: "not-connected", last_connected: state.connected_at },
        { status: 503, headers: { "Retry-After": "10", "Cache-Control": "no-store" } },
      );
    }
    return new Response(panelNotConnectedPage(state.name, state.connected_at, Boolean(state.connected_at)), {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8", "Retry-After": "10", "Cache-Control": "no-store" },
    });
  }
}

function concat(parts: Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
