/** The few pages this Worker shows a person. Plain HTML, one stylesheet. */

import type { BillingView } from "./billing";
import type { DriveGrant } from "./db";
import type { Account, Device } from "./env";
import { SELLABLE, TIERS, type TierName } from "./tiers";
import { escapeHtml as h, panelUrl } from "./util";

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34em; margin: 4em auto; padding: 0 1.5em; }
  h1 { font-size: 1.4em; margin-bottom: 0.2em; }
  .muted { opacity: 0.7; font-size: 0.9em; }
  code, input.code { font: 1.3em/1 ui-monospace, monospace; letter-spacing: 0.12em; }
  input, button { font: inherit; padding: 0.5em 0.8em; border-radius: 6px; border: 1px solid #8884; }
  button { cursor: pointer; }
  button.primary { background: #2563eb; color: white; border-color: transparent; }
  form.row { display: flex; gap: 0.6em; flex-wrap: wrap; align-items: center; margin: 1em 0; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  td, th { text-align: left; padding: 0.4em 0.6em 0.4em 0; border-bottom: 1px solid #8883; vertical-align: top; }
  .ok { color: #15803d; }
  .warn { color: #b45309; }
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} · Syllabus</title><style>${STYLE}</style></head>
<body><h1>${h(title)}</h1>${body}</body></html>`;
}

const FOOTER = `<p class="muted" style="margin-top:3em"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="https://github.com/trace-J/LectureAI">Syllabus on GitHub</a></p>`;

export function landing(): string {
  return page(
    "Syllabus accounts",
    `<p class="muted">Syllabus records your lectures on your Mac and files study notes in your Google Drive.
        Sign in to connect a Mac running Syllabus to your account.</p>
     <p><a href="/login"><button class="primary">Sign in with Google</button></a></p>${FOOTER}`,
  );
}

export function privacyPage(): string {
  return page(
    "Privacy",
    `<p class="muted">Last updated September 13, 2026.</p>
     <p>Syllabus is a personal lecture-recording tool. The recording, transcription, and summarizing all happen on
        the Mac that runs it. This account service exists so that a Mac can be tied to your identity and so your
        settings and your Google Drive connection can follow you to another Mac.</p>
     <h2>What this service stores</h2>
     <ul>
       <li><strong>Who you are.</strong> When you sign in with Google we keep your Google account id, email address, and
           display name.</li>
       <li><strong>Your Macs.</strong> The name of each Mac you connect, when it connected, when it last checked in, and,
           when it is published on the web, its address. Each Mac holds a token that identifies it; we keep only a hash
           of that token.</li>
       <li><strong>Your settings.</strong> The text of your class schedule, so it can follow you to another Mac.</li>
       <li><strong>Your Google Drive connection.</strong> If you connect Drive, the refresh token Google issues is stored
           encrypted and is used only to mint short-lived access tokens for your own Macs. The Macs never receive the
           refresh token. Syllabus asks only for the <code>drive.file</code> permission, which reaches files Syllabus
           itself created and nothing else in your Drive.</li>
     </ul>
     <p>Recordings, transcripts, summaries, and API keys never come to this service. They live on your Mac and in your
        own Google Drive.</p>
     <h2>How it is used</h2>
     <p>Only to run Syllabus for you: signing you in, telling your Macs who they belong to, syncing your settings, and
        letting your Macs file notes to your Drive. Nothing is sold, shared with advertisers, or used to build
        profiles. Syllabus's use and transfer of information received from Google APIs adheres to the
        <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data
        Policy</a>, including the Limited Use requirements.</p>
     <h2>Where it lives</h2>
     <p>On Cloudflare, in a database that belongs to this service. Traffic to and from it is encrypted.</p>
     <h2>Your choices</h2>
     <ul>
       <li>Remove a Mac from your account page at any time; its token stops working at once.</li>
       <li>Disconnect Google Drive from your account page; the grant is revoked at Google for every Mac at once.
           You can also remove Syllabus under your Google account's third-party access settings.</li>
       <li>To delete your account and everything stored with it, open an issue at
           <a href="https://github.com/trace-J/syllabus-accounts">github.com/trace-J/syllabus-accounts</a> or use
           the support email on the Google sign-in screen, and it will be removed.</li>
     </ul>
     <p>This service is open source; its code is at
        <a href="https://github.com/trace-J/syllabus-accounts">github.com/trace-J/syllabus-accounts</a>.</p>
     ${FOOTER}`,
  );
}

export function termsPage(): string {
  return page(
    "Terms",
    `<p class="muted">Last updated September 13, 2026.</p>
     <p>Syllabus and this account service are provided as they are, free of charge, for recording and studying your own
        lectures. Use them only for recordings you are allowed to make, and follow your school's rules about
        recording classes.</p>
     <p>You are responsible for what you record and for the Google account and Drive you connect. We may remove an
        account that abuses the service. The service may change or stop at any time; your recordings and notes stay in
        your own Google Drive regardless.</p>
     <p>There is no warranty of any kind, and the people behind Syllabus are not liable for any loss arising from its
        use, to the extent the law allows.</p>
     <p>Questions: open an issue at
        <a href="https://github.com/trace-J/syllabus-accounts">github.com/trace-J/syllabus-accounts</a>.</p>
     ${FOOTER}`,
  );
}

function when(iso: string): string {
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

/** What a Mac's relay object says about it, or null when it could not be asked. */
export type RelayInfo = { connected: boolean; connected_at: string; disconnected_at: string } | null;

function relayLine(d: Device, info: RelayInfo | undefined, publicUrl: string): string {
  const address = panelUrl(publicUrl, d.id);
  const link = `<a href="${h(address)}">${h(address.replace(/^https:\/\//, ""))}</a>`;
  if (!info) return `<br><span class="muted">Its panel: ${link}</span>`;
  if (info.connected) return `<br><span class="ok">Connected now</span> <span class="muted">at ${link}</span>`;
  const last = info.connected_at ? `, last connected ${when(info.connected_at)}` : ", has not connected yet";
  return `<br><span class="muted">Not connected${last}. Its panel: ${link}</span>`;
}

export function accountPage(
  account: Account,
  devices: Device[],
  grant: DriveGrant | null = null,
  relays: Record<string, RelayInfo> = {},
  publicUrl = "",
  billing: BillingView | null = null,
  notice = "",
): string {
  const rows = devices.length
    ? devices
        .map(
          (d) => `<tr><td><strong>${h(d.name)}</strong><br><span class="muted">${h(d.profile)}, added ${when(d.created_at)}</span>${publicUrl ? relayLine(d, relays[d.id], publicUrl) : ""}</td>
                  <td class="muted" style="white-space:nowrap">last seen ${when(d.last_seen_at)}</td>
                  <td><form method="post" action="/devices/${h(d.id)}/revoke"><button>Remove</button></form></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="muted">No Macs yet. Open the Setup page in Syllabus and choose Sign in to a Syllabus account.</td></tr>`;
  return page(
    "Your Syllabus account",
    `${billingNotice(notice)}<p>Signed in as <strong>${h(account.email)}</strong>${account.name ? ` (${h(account.name)})` : ""}.
        <form method="post" action="/logout" style="display:inline"><button>Sign out</button></form></p>
     <h2>Your Macs</h2>
     <p class="muted">Each Mac's panel has an address here that only you can open, from any browser or phone, whenever that Mac is awake and its panel is running.</p>
     <table><tbody>${rows}</tbody></table>
     ${devices.length ? signOutEverything : ""}
     <h2>Your plan</h2>
     ${billingSection(billing)}
     <h2>Google Drive</h2>
     ${driveSection(grant)}
     <h2>Connect a Mac</h2>
     <p class="muted">Syllabus shows a code on its Setup page. Enter it here.</p>
     ${codeForm("", "")}`,
  );
}

/**
 * A word about the checkout the person has just come back from.
 *
 * Coming back is not the same as having paid. Stripe redirects the moment its
 * own page is done, and what an account may spend is written when the webhook
 * arrives, which is usually within a second but is a different event. So this
 * says what happened at Stripe and lets the plan below say what is true here,
 * rather than promising a plan this page has not read yet.
 */
function billingNotice(notice: string): string {
  if (notice === "done") {
    return `<p class="ok">Thanks. Stripe has your subscription. It can take a moment to show up below.</p>`;
  }
  if (notice === "canceled") return `<p class="muted">No change was made and nothing was charged.</p>`;
  return "";
}

/**
 * What the person is paying for, and what is left of it.
 *
 * Every number here is read from the same `allowances` row the proxy
 * enforces, so the page cannot flatter the account. It does not decide
 * anything: a panel that is refused is refused by the proxy, not by what this
 * paragraph says.
 */
function billingSection(view: BillingView | null): string {
  if (!view) return `<p class="muted">Billing is not switched on yet.</p>`;

  const source = view.allowance?.source || "trial";
  const allowedSeconds = view.allowance?.audio_seconds ?? 5 * 3600;
  const left = Math.max(0, allowedSeconds - view.audioUsed);
  const usedLine = view.audioUsed <= 0
    ? `<p class="muted">Nothing recorded this month. All ${hours(allowedSeconds)} are yours.</p>`
    : `<p class="muted">${hours(view.audioUsed)} of ${hours(allowedSeconds)} used this month. ${hours(left)} left.</p>`;

  const sub = view.subscription;
  const manage = view.hasCustomer
    ? `<form method="post" action="/billing/portal" style="display:inline"><button>Manage billing</button></form>`
    : "";

  if (source === "lapsed" || (sub && sub.status === "canceled")) {
    return `<p class="warn">Your subscription has ended, so there are no hours on this account.</p>
      <p class="muted">Starting one again picks up where you left off. Your notes in Drive were never touched.</p>
      ${tierButtons()}${manage ? `<p>${manage}</p>` : ""}`;
  }

  if (sub) {
    const name = sub.tier ? sub.tier[0].toUpperCase() + sub.tier.slice(1) : "Your plan";
    const ends = sub.current_period_end ? onDate(sub.current_period_end) : "";
    const renewal = !ends
      ? ""
      : sub.cancel_at_period_end
        ? `<p class="warn">Ends ${ends}. You keep these hours until then.</p>`
        : `<p class="muted">Renews ${ends}.</p>`;
    const state = sub.status === "past_due"
      ? `<p class="warn">Stripe could not charge your card and is trying again. Nothing has been cut off.</p>`
      : "";
    return `<p><strong>${h(name)}</strong>, $${priceOf(sub.tier)} a month.</p>${state}${renewal}${usedLine}
      <p>${manage}</p>`;
  }

  return `<p>You are on the free trial: <strong>5 hours</strong> of lecture audio.</p>${usedLine}
    <p class="muted">Pick a plan to keep recording once the trial is used up. Every plan files to your own Drive, and you can change or cancel it yourself at any time.</p>
    ${tierButtons()}`;
}

function tierButtons(): string {
  return SELLABLE.map(
    (t) => `<form method="post" action="/billing/checkout" class="row" style="margin:0.4em 0">
        <input type="hidden" name="tier" value="${h(t.tier)}">
        <button class="primary">Choose ${h(t.label)}</button>
        <span class="muted">${h(t.note)}</span>
      </form>`,
  ).join("");
}

function priceOf(tier: string): number {
  return TIERS[tier as TierName]?.price_usd ?? 0;
}

/**
 * Seconds as something a person says out loud.
 *
 * Rounded to one decimal below ten hours and to whole hours above, because
 * "36 hours left" is what somebody plans a week around and "36.4" is not.
 * Singulars are handled: a first lecture should not read "1 hours".
 */
function hours(seconds: number): string {
  if (seconds <= 0) return "none";
  if (seconds < 60) return "under a minute";
  if (seconds < 3600) {
    const mins = Math.round(seconds / 60);
    return `${mins} ${mins === 1 ? "minute" : "minutes"}`;
  }
  const count = seconds / 3600;
  const shown = count >= 10 ? Math.round(count) : Math.round(count * 10) / 10;
  return `${shown} ${shown === 1 ? "hour" : "hours"}`;
}

/** A renewal date, said the way a date is said rather than logged. */
function onDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/**
 * For a Mac that was lost or a token that may have been copied: removing the
 * Macs one at a time is not enough if whoever holds the token can connect
 * more while you work, so this ends every connection in one go.
 */
const signOutEverything = `<p class="muted">Lost a Mac, or think someone else has a copy of its connection?
  <form method="post" action="/devices/revoke-all" style="display:inline"><button>Sign out every Mac</button></form>
  Each one asks for a new code the next time you open it.</p>`;

function driveSection(grant: DriveGrant | null): string {
  if (grant && !grant.revoked_at) {
    return `<p><span class="ok">Connected</span> as <strong>${h(grant.google_email || "your Google account")}</strong> since ${when(grant.granted_at)}.
      Every Mac on this account files to that Drive.
      <form method="post" action="/drive/disconnect" style="display:inline"><button>Disconnect</button></form></p>`;
  }
  const why = grant?.revoked_at ? `<p class="warn">The earlier connection stopped working: ${h(grant.revoked_reason || "it was revoked")}.</p>` : "";
  return `${why}<p class="muted">Connect once, and every Mac signed in to this account files its notes to your Drive. Syllabus only sees files it created.</p>
    <p><a href="/drive/connect"><button class="primary">Connect Google Drive</button></a></p>`;
}

/** Someone signed in, but not the person whose Mac this is. */
export function notYoursPage(email: string): string {
  return page(
    "Not yours",
    `<p>That Syllabus belongs to someone else. You are signed in as <strong>${h(email)}</strong>.</p>
     <p><form method="post" action="/logout" style="display:inline"><button>Use a different account</button></form></p>`,
  );
}

/**
 * The panel's Mac is not holding its connection to us right now: asleep,
 * offline, or the panel is not running. Shown in place of a timeout, and it
 * retries on its own.
 */
export function panelNotConnectedPage(deviceName: string, lastConnected: string, everConnected: boolean): string {
  const name = deviceName || "That Mac";
  const since = lastConnected ? `<p class="muted">Last connected ${when(lastConnected)}.</p>` : "";
  const how = everConnected
    ? `<p>Syllabus reaches this address on its own whenever its panel is running and the Mac is awake and online. Wake the Mac, or check <code style="font-size:1em;letter-spacing:0">intake service status</code> there.</p>`
    : `<p>Syllabus has not connected from that Mac yet. It does so on its own once the panel is running and the Mac is signed in to your account.</p>`;
  return page(
    `${h(name)} is not connected`,
    `${how}${since}<p class="muted">This page tries again every 10 seconds.</p>
     <p class="muted"><a href="/">Your account</a></p>`,
  ).replace("<title>", '<meta http-equiv="refresh" content="10"><title>');
}

export function codeForm(code: string, error: string): string {
  return `<form class="row" method="post" action="/device/approve">
      <input class="code" name="user_code" value="${h(code)}" placeholder="WXYZ-2345" autocomplete="off" required>
      <button class="primary">Connect</button>
      ${error ? `<span class="warn">${h(error)}</span>` : ""}
    </form>`;
}

export function devicePage(account: Account, code: string, deviceName: string, error: string): string {
  const intro = deviceName
    ? `<p>A Mac called <strong>${h(deviceName)}</strong> is asking to join <strong>${h(account.email)}</strong>.</p>`
    : `<p>Enter the code Syllabus is showing to connect that Mac to <strong>${h(account.email)}</strong>.</p>`;
  return page("Connect a Mac", intro + codeForm(code, error) + `<p class="muted"><a href="/">Your account</a></p>`);
}

export function approvedPage(account: Account, deviceName: string): string {
  return page(
    "Connected",
    `<p class="ok"><strong>${h(deviceName)}</strong> now belongs to ${h(account.email)}.</p>
     <p>Go back to Syllabus; it will notice within a few seconds.</p>
     <p class="muted"><a href="/">Your account</a></p>`,
  );
}
