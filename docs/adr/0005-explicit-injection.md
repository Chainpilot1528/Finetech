# 0005: Explicit Nest injection

**Status:** Accepted

**Context.** tsx and vitest compile with esbuild, which doesn't emit decorator metadata.

**Decision.** Every constructor parameter uses @Inject.

**Consequences.** No extra compiler is needed, at the cost of a little repetition.
