/** The few pages this Worker shows a person. Plain HTML, one stylesheet. */

import type { DriveGrant } from "./db";
import type { Account, Device } from "./env";
import { escapeHtml as h } from "./util";

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

export function landing(): string {
  return page(
    "Syllabus accounts",
    `<p class="muted">Sign in to connect a Mac running Syllabus to your account.</p>
     <p><a href="/login"><button class="primary">Sign in with Google</button></a></p>`,
  );
}

function when(iso: string): string {
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

export function accountPage(account: Account, devices: Device[], grant: DriveGrant | null = null): string {
  const rows = devices.length
    ? devices
        .map(
          (d) => `<tr><td><strong>${h(d.name)}</strong><br><span class="muted">${h(d.profile)}, added ${when(d.created_at)}${d.public_url ? `, at <a href="${h(d.public_url)}">${h(d.public_url.replace(/^https:\/\//, ""))}</a>` : ""}</span></td>
                  <td class="muted">last seen ${when(d.last_seen_at)}</td>
                  <td><form method="post" action="/devices/${h(d.id)}/revoke"><button>Remove</button></form></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="muted">No Macs yet. Open the Setup page in Syllabus and choose Sign in to a Syllabus account.</td></tr>`;
  return page(
    "Your Syllabus account",
    `<p>Signed in as <strong>${h(account.email)}</strong>${account.name ? ` (${h(account.name)})` : ""}.
        <form method="post" action="/logout" style="display:inline"><button>Sign out</button></form></p>
     <h2>Your Macs</h2>
     <table><tbody>${rows}</tbody></table>
     <h2>Google Drive</h2>
     ${driveSection(grant)}
     <h2>Connect a Mac</h2>
     <p class="muted">Syllabus shows a code on its Setup page. Enter it here.</p>
     ${codeForm("", "")}`,
  );
}

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
