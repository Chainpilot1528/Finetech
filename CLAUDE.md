# Vittora

Loan-distribution partner portal. Monorepo: `apps/api` (NestJS), `apps/web` (Next.js),
`packages/api-contract` (OpenAPI), `packages/shared-kernel`, `db/migrations` (plain SQL).

## Commands
- `pnpm setup`, then `pnpm db` (leave running), `pnpm seed`, `pnpm dev`
- `pnpm test` (API, spins up its own Postgres) · `pnpm e2e` (needs the stack running and a fresh `pnpm seed`)
- `pnpm typecheck` · `pnpm lint` · `pnpm contract:gen` after editing `openapi.yaml`

## Rules that must not bend
- The repo is PUBLIC. No secrets, no real data, and never commit the PRD.
- Tenant scope comes from the session, never from request input. Use `Db.withTenant`.
- `Db.withAuth` is for sign-in, sign-up and the public consent page only. `Db.withOps` is for the ops console. Both bypass tenant RLS.
- Never store a full Aadhaar number, in any field or draft. Only the last 4 digits and masked copies.
- Product rules live in `packages/product-schemas`, shared by the wizard and the API. Don't copy them.
- Every route is denied unless signed in. `@Public()` is a deliberate, reviewed choice.
- Contract first: change `openapi.yaml` with the route. The authz matrix test reads it, so give every operation an `x-access`.
- Audit rows hold ids and codes only, never names, emails, phones or tokens.
- Migrations are forward-only. Add a new file; never edit an applied one.
- No `@Inject`-less constructors: tests and dev run without decorator metadata.
- A bug fix starts with a failing test.
