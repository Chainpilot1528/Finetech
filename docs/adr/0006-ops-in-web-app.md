# 0006: Ops console inside the web app for now

**Status:** Accepted

**Context.** The PRD suggests a separate apps/ops with its own SSO. No identity provider is chosen, and a second app doubles the shared UI work.

**Decision.** The console lives at /ops in apps/web. It has its own sign-in endpoint, mandatory two-step sign-in, internal-only roles and a separate vittora_ops database role. Partner and staff sign-ins refuse each other's accounts.

**Consequences.** Less to build now. Split it into apps/ops when SSO is chosen, before launch.
