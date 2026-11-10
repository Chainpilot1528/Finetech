# Vittora

A partner portal for loan distribution. Partners log loan cases, track them to disbursal and get paid commission.

## Run it locally

Needs Node 22+ and pnpm. No Docker or cloud account needed.

```bash
pnpm install
pnpm contract:gen
pnpm setup:env
pnpm db      # leave this running in its own terminal
pnpm seed    # in a second terminal
pnpm dev
```

Open http://localhost:3000. Test logins are in `.dev/seed-credentials.md`, and emails and texts appear at
http://localhost:3000/dev/inbox. Staff accounts sign in at http://localhost:3000/ops/signin.

`pnpm setup:env` creates `.env` with fresh random secrets. (It isn't called `pnpm setup`, because that
is a built-in pnpm command that edits your shell profile instead.)

**On a Mac with Apple Silicon, use the arm64 build of Node.** An Intel Node under Rosetta makes the dev
server and browser tests several times slower. Check with `node -p process.arch`, which should print `arm64`.

### The dev mailbox is for your laptop only

The dev mailbox shows every sign-in link, reset link and one-time code. It only runs when
`DEV_MAILBOX=true`, the API refuses to start with it unless it listens on `127.0.0.1`, and `pnpm dev`
binds the web app to `127.0.0.1` too. Never run the app this way on a shared or public host.

## Tests

```bash
pnpm test    # API tests against a real, throwaway Postgres
pnpm e2e     # browser tests; needs the stack running and a fresh `pnpm seed`
```

On a slow machine, stretch the waits instead of editing tests:
`E2E_TIMEOUT_MS=120000 E2E_EXPECT_MS=15000 pnpm e2e`. CI runs the browser tests against a production
build (`next build` and `next start`).

Only fake data belongs in this public repository. Secrets stay in `.env`, which is never committed.
