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
  identifies it from then on. `/` lists the Macs on an account, each with its
  panel's address and whether that panel is connected right now, and can remove one.
- **Who am I.** `GET /me` answers a browser session or a device bearer with the
  account and, for a device, which Mac it is.
- **Reach a panel over the web.** `/p/<device>/` relays a signed-in
  browser to that Mac's panel over a Durable Object socket, when the account
  owns it. Anyone else is told the panel is not theirs.

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

## The proxy

Managed keys. A panel used to need its owner's own OpenAI and Anthropic keys
in `~/.intake/syllabus/.env`; now the keys are Worker secrets here and the
two paid calls are made from this service instead:

    POST /proxy/transcribe   multipart: an `audio` part and `duration_seconds`
                             -> { text, audio_seconds }
    POST /proxy/summarize    { transcript, course, date }
                             -> { summary, tokens }
    GET  /proxy/usage        what is left this month

Both paid endpoints take a device bearer, never a browser session.

Transcription runs on Groq (`whisper-large-v3`) and falls back to OpenAI
(`gpt-4o-mini-transcribe`). Transcription is nearly the whole cost of an hour
of lecture, and Groq serves the same job for $0.111 an hour against OpenAI's
$0.18, speaking the same API. OpenAI stays because this service spends one
key for everybody, so a provider rate limit would otherwise be a ceiling on
the whole product; falling back means hitting one costs money rather than
costing transcriptions. Any Groq failure takes the fallback, not just a 429,
and every fall-through is logged, because a Groq key that has quietly stopped
working should show up in the logs and not on a card statement. `GROQ_API_KEY`
is optional: with it unset every transcription goes to OpenAI, exactly as
before.

Every settled usage row records which provider served it, so the split can be
read back rather than caught live in the logs. An account sees its own on
`GET /proxy/usage` as `transcribed_by`. Across every account, which is an
operator's question and deliberately not an endpoint:

    npm run split

      2026-10
      provider        calls    hours   share   est. cost
      --------------------------------------------------
      groq               90     9.00     90%       $1.00
      openai             10     1.00     10%       $0.18
      --------------------------------------------------
      total             100    10.00               $1.18

      Effective: $0.12/audio hour (all-Groq would be $0.11, all-OpenAI $0.18)

That groups by period and provider and prices each leg at its published rate.
The last line is the one to read: a month that looks cheap in a forecast and
expensive on the card is a month whose effective rate drifted toward $0.18.
The dollars are an estimate from list prices, not a bill.

`unrecorded` is a call from before the provider column existed, not a third
provider, and it is deliberately not priced: guessing a rate for those rows
would invent the number the table exists to stop guessing at. A period holding
any of them totals with `>=`.

This is not a general-purpose API gateway, and the difference matters because
the keys being spent are ours. The model, the upstream URL, the request
shape, the system prompt and the response schema are all fixed in `proxy.ts`
and `prompts.ts`. A caller sends audio, or a transcript and the two labels
that frame it, and can pick nothing else; the prompt set comes from the
profile on the caller's own device row. An upstream error is never passed
through, so a rejected key tells the caller only that the provider was
unavailable.

Three things bound what a stolen device token can cost, which until this
existed was nothing:

- A monthly allowance per account, checked before the upstream call. The
  default is the 5-hour trial; slice 4 (Stripe) is what writes real ones.
- 20 transcriptions and 5 summaries per account per minute.
- 12MB per audio chunk and 400,000 characters per transcript, refused
  outright rather than handled.

Audio seconds come from the file, not from the caller: an .m4a states its
length in its `moov/mvhd` header and that is what is billed. A declared
duration can only raise the charge, never lower it, and audio whose header
cannot be read is billed as though it were 32kbps, which makes an
unreadable upload the expensive way to send audio rather than the cheap
one. A byte count alone would not do, since the same 12MB is eight minutes
at 192kbps and over three hours at 8kbps.

## What is stored

`accounts` (Google sub, email, name), `devices` (one per claimed panel, with
a profile and a name), `device_tokens` (hashes only), `device_codes`
(claims in progress), and `settings`
(named documents per account and profile, the schedule first), and
`drive_grants` (one encrypted refresh token per account, and which Google
account granted it), and `usage` plus `allowances` (what the proxy spent and
what it may spend, as numbers). No recording, transcript, or API key ever
comes here: audio and transcripts stream through the proxy to the provider
and only the unit count is kept.

`subscriptions` mirrors what Stripe says an account pays for, and
`stripe_events` records every webhook event id so a retried delivery is
handled once. Neither carries a card number or anything else about a payment
method; Stripe holds all of that. `src/tiers.ts` is the one place the tiers
are written down, and turns a subscription into the `allowances` row the
proxy reads. Nothing writes an `allowances` row yet: every account is on the
trial until the Stripe webhook lands.

## What was retired

The panel sign-in that a Cloudflare Tunnel needed. `/panel/authorize`,
`/panel/exchange` and `/device/public-url`, the `panel_codes` table, and
each device's `public_url` went on 2026-09-17, once every panel reached the
web through the relay instead. Migration `0008_retire_panel_signin.sql`
takes the table and the column out of D1.
