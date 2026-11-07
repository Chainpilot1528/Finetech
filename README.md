# Vittora

A partner portal for loan distribution. Partners log loan cases, track them to disbursal and get paid commission.

## Run it locally

Needs Node 22+ and pnpm. No Docker or cloud account needed.

```bash
pnpm install
pnpm contract:gen
pnpm setup
pnpm db      # leave this running in its own terminal
pnpm seed    # in a second terminal
pnpm dev
```

Open http://localhost:3000. Test logins are in `.dev/seed-credentials.md`, and emails appear at
http://localhost:3000/dev/inbox.

## Tests

```bash
pnpm test    # API tests against a real, throwaway Postgres
pnpm e2e     # browser tests; needs the stack running and a fresh `pnpm seed`
```

Only fake data belongs in this public repository. Secrets stay in `.env`, which is never committed.
