# syllabus-accounts: repo instructions (Claude Code: follow this automatically)

**Personal repo of Trace (`github.com/trace-J`), NOT a Groundbreaker fleet repo.**
`~/apps/CLAUDE.md` does not apply here: never move this into the org, never
include it in fleet sweeps, and do not use `client-factory` or the VPS runner.
It is the account backend for [LectureAI](https://github.com/trace-J/LectureAI)
(Syllabus), and both repos are public.

## Git workflow

1. `git checkout main && git pull --ff-only`
2. Branch before editing, never commit on `main`: `git checkout -b trace-J/<short-description>`
3. `git add -A && git commit -m "message"`
4. `git push -u origin <branch>`, `gh pr create --fill`, `gh pr merge --squash --delete-branch`

## Hard rules

- **No secrets in the repo.** `GOOGLE_CLIENT_SECRET` and `SESSION_SECRET` live
  in the Worker (`npx wrangler secret put`) and in the gitignored `.dev.vars`.
  The Google client id in `wrangler.jsonc` is public by design.
- Deploy is `npm run deploy` from `main` after the PR merges; run
  `npm run db:migrate:remote` first when a migration was added.
- Copy anyone reads: no em dashes, US spelling and phrasing.
- `npm test` and `npm run typecheck` must pass before a PR.
