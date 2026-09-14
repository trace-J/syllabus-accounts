# syllabus-accounts

Accounts for [Syllabus](https://github.com/trace-J/LectureAI): a Google sign-in,
and a way for the Syllabus panel running on somebody's Mac to claim an
identity under it. A Cloudflare Worker with a D1 database, published at
`syllabusaccounts.maincoursemedia.com`.

Syllabus records lectures on the Mac it runs on, so a person's Syllabus has to
run on their Mac. This service does not change that. It gives each running
panel an identity, and, in later phases, a home for that person's settings and
their Google Drive grant.

## What it does today

- **Sign in with Google.** `/login` sends the browser to Google, `/oauth2/callback`
  checks the ID token and sets a signed 30-day session cookie. An account is
  created on first sign-in, keyed by the Google `sub`.
- **Claim a Mac** with a device code. The panel asks for a code, the person
  types it here while signed in, and the panel receives a bearer token that
  identifies it from then on. `/` lists the Macs on an account and can remove one.
- **Who am I.** `GET /me` answers a browser session or a device bearer with the
  account and, for a device, which Mac it is.
- **Sign in to a panel over the web.** A panel published through a tunnel
  sends a browser with no session to `/panel/authorize`; if the signed-in
  account owns that panel's device, the browser goes back to the panel with a
  one-time code, and the panel redeems it at `/panel/exchange` with its own
  device token. Anyone else is told the panel is not theirs. A panel tells us
  where it is published with `POST /device/public-url`, and a browser is only
  ever sent back to that address.

## The device flow

```
panel                                    this Worker                    browser
POST /device/start  ------------------>  code WXYZ-2345 issued
   shows "enter WXYZ-2345 at ..."                                        person signs in
                                         GET /device?code=  <----------  sees the Mac's name
                                         POST /device/approve <--------  clicks Connect
POST /device/poll   ------------------>  first poll after approval
   receives token syd_...                mints the token, once
GET /me  (Authorization: Bearer syd_...) -> {account, device}
```

Codes live fifteen minutes; the poll interval is five seconds. The token is
minted at collection, so it exists in plain form only in the one response
that carries it; the database keeps a SHA-256 of it. Removing a Mac on the
account page, or `POST /device/revoke` from the panel itself, ends the token.

- **Settings documents.** `GET` and `PUT /settings/:name` with the device
  bearer store small named texts per account and profile. The first is
  `schedule`, the panel's schedule file, so a class schedule follows its
  owner to another Mac. A `PUT` with `expected_updated_at` is refused with a
  409 and the current document when another Mac wrote in between; the panel
  decides which copy wins.

- **A panel on the web, for every Mac.** Each claimed device has an address
  here, `/p/<device>/`, that reaches the panel running on that Mac. The
  panel holds a WebSocket open to this service (`GET /relay/connect`, with
  its device bearer), and a browser's requests to the address travel down
  it. Only the account that owns the device gets in; the account session
  here is the sign-in. Nothing is installed or configured on the Mac beyond
  Syllabus itself. See "The relay" below.

- **Google Drive on the account.** `/drive/connect` (signed in) runs the
  Drive consent for the `drive.file` scope through the same callback the
  sign-in uses; the refresh token is stored encrypted under the `DRIVE_KEY`
  secret. A panel asks `POST /drive/token` with its device bearer and gets a
  one-hour access token; it never sees the refresh token. `GET /drive/status`
  says whether a grant exists, and `/drive/disconnect` revokes it at Google
  and forgets it. A grant Google stops honoring is marked revoked and the
  account page says so.

## Signing in to a panel

```
browser -> panel (through its tunnel, no session)
        <- 302 to /panel/authorize?device=&redirect_uri=&state=
browser -> this Worker: signs in with Google if needed; the account must own the device
        <- 302 to redirect_uri?code=&state=          (code lives five minutes, redeemed once)
panel   -> POST /panel/exchange {code}  Authorization: Bearer syd_...
        <- {account: {id, email, name}}
panel sets its own session cookie for that person
```

The code alone is worthless: only the device it was minted for can redeem
it, and `redirect_uri` has to sit on the address that device registered.

## The relay

```
panel (intake/relay.py)                  this Worker                              browser
GET /relay/connect  (Bearer syd_...)  -> PanelRelay object for the device
   Upgrade: websocket                    holds the socket; sends {t:"welcome"}
                                         GET /p/<device>/api/status  <----------  owner, signed in here
   <- {t:"req", id, method, path, query, headers, viewer, base, body}
   runs it against the local Flask app
   -> {t:"res", id, status, headers, body, more?}  (then {t:"chunk", ...})
                                         200 with the panel's answer  --------->
```

One Durable Object per device (`src/panel-relay.ts`) holds that panel's
socket and matches answers to requests by id. Bodies are base64 inside JSON
frames; a message on Cloudflare may not exceed 1 MiB, so the panel splits
long answers at the chunk size the welcome frame names, and the object caps
the whole at 4 MB. Only what the panel serves is carried: `/`, `/setup`,
`/api/*`, and `/static/*`, by GET or POST. Requests from another origin, a
body over 64 KB, or any other path are refused before they reach the Mac.

Who the viewer is (`viewer.email`, `viewer.account_id`) rides in every
frame, and `base` is the path prefix the panel should write its links under.
The panel trusts both because they arrived on the socket it opened with its
own token. The service never sees the Mac's recordings or keys: the panel
serves neither.

When the Mac is asleep, offline, or its panel is not running, there is no
socket, and the browser gets a 503 page saying so, with the Mac's name and
when it was last connected, refreshing every 10 seconds; `/api/` paths get a
JSON 503 with `relay: "not-connected"`. A request the panel does not answer
in 25 seconds is a 504, and the socket is closed as dead, so a lid closed
without a clean goodbye shows as not connected on the next request rather
than hanging. The object hibernates between messages; the panel's pings are
answered without waking it. The Durable Object class is SQLite-backed
(`new_sqlite_classes` in `wrangler.jsonc`), which every Workers plan allows.

## Running it

```bash
npm install
cp .dev.vars.example .dev.vars    # fill in the two secrets
npm run db:migrate                # local D1
npm run dev                       # http://localhost:8787
npm test
npm run typecheck
```

Tests run inside workerd against a throwaway D1 with the migrations applied;
nothing reaches Google. The token endpoint is stubbed where a test needs it.

## Deploying

```bash
npm run db:migrate:remote         # when a migration was added
npm run deploy
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put DRIVE_KEY
```

Changing `DRIVE_KEY` makes every stored Drive grant unreadable; people
would reconnect Drive from the account page.

The Worker's route is a custom domain, so `wrangler deploy` also creates the
DNS record. The Google side is a **Web application** OAuth client in Google
Cloud project **friendly-bazaar-507320-b7**, the same project as the Desktop
client Syllabus ships for `intake login`. That matters for Drive: the
`drive.file` scope only reaches files created by the same project, so
keeping both clients in one project is what lets a Drive grant on the
account see the "Lecture Notes" folder a Mac's own token created, and the
other way around. (The first version of this service used a Web client in
a separate project named LectureAI; the panel's own fallback sign-in still
does.) The Drive consent comes back through the same callback as the
sign-in; the client's authorized redirect URIs must include
`https://syllabusaccounts.maincoursemedia.com/oauth2/callback` and, for
`npm run dev`, `http://localhost:8787/oauth2/callback`. The project's
consent screen is published (In production), with `maincoursemedia.com`
verified in Search Console, which Google requires before publishing.

## What is stored

`accounts` (Google sub, email, name), `devices` (one per claimed panel, with
a profile, a name, and the address it is published at), `device_tokens`
(hashes only), `device_codes` (claims in progress), and `panel_codes`
(browser sign-ins on their way to a panel, hashes only), and `settings`
(named documents per account and profile, the schedule first), and
`drive_grants` (one encrypted refresh token per account, and which Google
account granted it). No recording, transcript, or API key ever comes here.

## Later phases

Retiring the tunnel path: `/panel/authorize`, `/panel/exchange`, and each
device's `public_url`, once every panel reaches the web through the relay.
