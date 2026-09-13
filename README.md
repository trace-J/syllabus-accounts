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
```

The Worker's route is a custom domain, so `wrangler deploy` also creates the
DNS record. The Google side is a **Web application** OAuth client in the
Google Cloud project named **LectureAI**, the same client the panel's own
sign-in uses. (The Desktop client Syllabus authorizes Drive with is in a
different project, friendly-bazaar-507320-b7; a client id starts with its
project's number, which is how to tell them apart.) Its authorized
redirect URIs must include
`https://syllabusaccounts.maincoursemedia.com/oauth2/callback` and, for
`npm run dev`, `http://localhost:8787/oauth2/callback`.

## What is stored

`accounts` (Google sub, email, name), `devices` (one per claimed panel, with
a profile and a name), `device_tokens` (hashes only), and `device_codes`
(claims in progress). No recording, transcript, or API key ever comes here.

## Later phases

Settings sync (the class schedule), the Drive grant held by the account and
short-lived access tokens handed to the panel, and the panel's web sign-in
delegated to this service. Each is its own PR in both repos.
