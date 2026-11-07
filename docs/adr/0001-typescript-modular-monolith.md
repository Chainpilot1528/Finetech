# 0001: TypeScript modular monolith

**Status:** Accepted

**Context.** A small team needs clear boundaries without running many services.

**Decision.** One NestJS deployable, split into modules with a public index each. Modules live in apps/api/src/modules until the worker app needs them.

**Consequences.** Extraction stays cheap, and front and back share types.
