# 0004: Sessions in Postgres for now

**Status:** Accepted

**Context.** The PRD prefers Redis, but Part 1 has no Redis yet and runs without Docker.

**Decision.** Keep sessions and rate-limit counters in Postgres behind the identity repository.

**Consequences.** Fine for development and the pilot. Revisit before the 500-user load test.
