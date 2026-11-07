# 0003: Cookie sessions, not localStorage JWT

**Status:** Accepted

**Context.** Tokens readable by scripts can be stolen by any XSS.

**Decision.** Opaque session id in an HttpOnly cookie, stored hashed, with signed double-submit CSRF tokens.

**Consequences.** Sessions can be revoked instantly. Each request reads the session store.
