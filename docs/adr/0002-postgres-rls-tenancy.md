# 0002: Postgres with Row-Level Security

**Status:** Accepted

**Context.** A missed WHERE clause must not leak another partner's data.

**Decision.** vittora_app is always bound by RLS through SET LOCAL app.partner_id. vittora_auth exists only for sign-in. vittora_owner runs migrations.

**Consequences.** Two pools, and a bug in app code still can't cross tenants.
