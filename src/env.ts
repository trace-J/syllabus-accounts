export type Bindings = {
  DB: D1Database;
  /** One PanelRelay Durable Object per device: the panel's socket, and the relay over it. */
  PANEL: DurableObjectNamespace;
  /** Where this Worker is published, no trailing slash. */
  PUBLIC_URL: string;
  /** The Web OAuth client in Google Cloud project friendly-bazaar-507320-b7. */
  GOOGLE_CLIENT_ID: string;
  /** Secret: the Web client's secret. `wrangler secret put GOOGLE_CLIENT_SECRET`. */
  GOOGLE_CLIENT_SECRET: string;
  /** Secret: signs the browser session cookie. `wrangler secret put SESSION_SECRET`. */
  SESSION_SECRET: string;
  /** Secret: encrypts stored Drive refresh tokens. `wrangler secret put DRIVE_KEY`. */
  DRIVE_KEY: string;
  /** Secret: the transcription key the proxy spends. `wrangler secret put OPENAI_API_KEY`. */
  OPENAI_API_KEY: string;
  /** Secret: the summary key the proxy spends. `wrangler secret put ANTHROPIC_API_KEY`. */
  ANTHROPIC_API_KEY: string;
};

export type Account = {
  id: string;
  google_sub: string;
  email: string;
  name: string;
  picture: string;
  created_at: string;
  last_signin_at: string;
  /** Bumped to orphan every device token this account has handed out. */
  token_version: number;
};

export type Device = {
  id: string;
  account_id: string;
  name: string;
  profile: string;
  public_url: string;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
};

/**
 * What every handler can read once the session or bearer middleware ran.
 *
 * `authKind` is the one a route should test when it cares HOW the caller
 * proved who they are. Both a browser cookie and a panel's bearer token set
 * `account`, so `account` alone answers "whose" and never "what kind".
 */
export type Variables = {
  account: Account | null;
  device: Device | null;
  authKind: AuthKind;
};

/** "session" is a person in a browser; "device" is a panel holding a token. */
export type AuthKind = "session" | "device" | null;

export type AppEnv = { Bindings: Bindings; Variables: Variables };
