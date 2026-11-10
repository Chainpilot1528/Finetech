# Decision log

Why Vittora is built the way it is, including what we chose **not** to do. Read this before re-opening a question.

- **Product decisions** are made by the product owner; **technical decisions** by the lead engineer. Either can propose.
- Large, hard-to-reverse technical decisions also get an ADR in `docs/adr/`; the entry here links to it.
- Review findings are referred to by ID (e.g. `SEC-01`, `BUG-02`). Their details live in the private review notes,
  not in this public repo. Never write exploit steps, real data or secrets here.
- Never delete an entry. If a decision changes, add a new entry and mark the old one **Superseded by D-NNN**.

**Status values:** `Accepted` · `Proposed` (awaiting the owner) · `Rejected` (we chose not to) · `Deferred` (not now, with a trigger to revisit) · `Superseded`

---

## Index

| ID | Date | Decision | Type | Status |
|---|---|---|---|---|
| D-001 | 2026-11-07 | Product name is Vittora | Product | Accepted |
| D-002 | 2026-11-07 | Six loan products, launched in waves | Product | Accepted |
| D-003 | 2026-11-07 | A robust v1 first; most borrowed practices wait for v1.5 | Product | Accepted |
| D-004 | 2026-11-07 | v1 exit criteria gate all v1.5 work | Product | Accepted |
| D-005 | 2026-11-07 | TypeScript modular monolith | Technical | Accepted (ADR-0001) |
| D-006 | 2026-11-07 | Tenant isolation enforced by Postgres Row-Level Security | Technical | Accepted (ADR-0002) |
| D-007 | 2026-11-07 | Cookie sessions, not tokens in browser storage | Technical | Accepted (ADR-0003) |
| D-008 | 2026-11-07 | Sessions and rate limits in Postgres for now | Technical | Deferred (ADR-0004) |
| D-009 | 2026-11-07 | Explicit `@Inject` on every constructor parameter | Technical | Accepted (ADR-0005) |
| D-010 | 2026-11-07 | Ops console lives inside the web app for now | Technical | Deferred (ADR-0006) |
| D-011 | 2026-11-07 | Documented deviations from the PRD for Parts 1–3 | Technical | Accepted |
| D-012 | 2026-11-09 | Fix the P0 review findings before starting Part 4 | Both | Accepted |
| D-013 | 2026-11-09 | Start Part 4 with the Case lifecycle and Notifications modules | Technical | Proposed |
| D-014 | 2026-11-09 | Block case creation until partner KYC is approved | Product | Proposed |
| D-015 | 2026-11-09 | GST certificate required only for GST-registered partners | Product | Proposed |
| D-016 | 2026-11-09 | Customer consent required before a case can be submitted | Product | Proposed |
| D-017 | 2026-11-09 | Partner agreement step and business contact fields at sign-up | Product | Proposed |
| D-018 | 2026-11-09 | Whether a disbursed case blocks a new one for the same customer | Product | Proposed |
| D-019 | 2026-11-09 | Browser tests stay on the dev server for now | Technical | Superseded by D-029 |
| D-020 | 2026-11-09 | Keep the well-designed modules as they are | Technical | Accepted |
| D-021 | 2026-11-09 | Parts 4–6 were built before the review; the fixes go on top | Both | Proposed |
| D-022 | 2026-11-09 | The outbox lives in Postgres, encrypted, cleared when done | Technical | Accepted |
| D-023 | 2026-11-09 | The case status guard is a trigger, not a transition function | Technical | Accepted |
| D-024 | 2026-11-09 | Consent needs a one-time code to the customer's phone | Technical | Accepted |
| D-025 | 2026-11-09 | Car loan limits: valuation cap, warning level, car age at maturity | Product | Proposed |
| D-026 | 2026-11-09 | Idempotency keys are honoured on every signed-in POST, not required | Technical | Accepted |
| D-027 | 2026-11-09 | The database's duplicate rule waits for D-018 | Technical | Deferred |
| D-028 | 2026-11-09 | Lists page in the API; screens still show the first page | Technical | Deferred |
| D-029 | 2026-11-09 | CI runs the browser tests against a production build | Technical | Accepted |

---

## Product decisions

### D-001 · Product name is Vittora
- **Decision:** the product is called *Vittora* (from Sanskrit *vitta*, wealth). It replaced the placeholder "LoanLane".
- **Why:** not tied to loans, so it still fits if insurance or investments are added; works in English and Hindi.
- **Not chosen:** Sanctio (says "loans" outright, but narrower), Arthaloop, Dhanpath, Caselane, Lendara.
- **Open:** trademark (IP India, classes 36, 9, 42), MCA company name and domain checks.

### D-002 · Six loan products, launched in waves
- **Decision:** Used Car Loan, Loan Against Car, Personal Loan, Business Loan, Home Loan, Education Loan.
  Wave 1: Used Car, Loan Against Car, Personal. Wave 2: Business. Wave 3: Home and Education. All six live at GA.
- **Why:** shortest document checklists first; Home and Education carry collateral and co-applicant rules.
- **Not chosen:** New Car, Gold and Insurance are out of scope for v1, but the product catalogue must make them configuration, not new code.

### D-003 · A robust v1 first
- **Decision:** v1 adopts only the borrowed practices that strengthen the core flow: earnings estimate on each case,
  time-in-stage, cross-partner duplicate check, the product catalogue, and disclosures with consent records.
- **Deferred to v1.5:** customer self-service links, eligibility pre-check, penny-drop and DigiLocker, document AI,
  SLA nudges and case chat, next-step checklists, fraud signals.
- **Deferred to v2:** PWA and WhatsApp, Account Aggregator and GST data pulls, lender API integrations, Partner Academy.
- **Why:** a smaller, well-tested v1 for 500 concurrent users beats a broad, fragile one.

### D-004 · v1 exit criteria gate all v1.5 work
- **Decision:** no v1.5 work takes engineering time until every v1 exit criterion in the PRD (§12.1) is met and
  signed off by product and engineering: scope, correctness, tenancy, scale, security, data safety, operability,
  compliance and a 4-week pilot.

---

## Technical decisions (from the ADRs)

### D-005 · TypeScript modular monolith — see ADR-0001
One NestJS deployable with a public index per module; front and back share types. **Not chosen:** microservices or a
Python backend. **Revisit:** only with an ADR showing a scaling, deployment or ownership reason.

### D-006 · Postgres Row-Level Security for tenancy — see ADR-0002
A missed `WHERE` clause must not leak another partner's data, so the database enforces tenant scope.

### D-007 · Cookie sessions — see ADR-0003
Opaque session id in an HttpOnly cookie with signed CSRF tokens. **Not chosen:** tokens in browser storage, which any XSS can steal.

### D-008 · Sessions and rate limits in Postgres for now — see ADR-0004
**Trigger to revisit:** before the 500-user load test (Part 8). Expected move: Redis.

### D-009 · Explicit injection — see ADR-0005
The test and dev compilers don't emit decorator metadata, so every constructor parameter uses `@Inject`.

### D-010 · Ops console inside the web app — see ADR-0006
**Trigger to revisit:** when an identity provider is chosen, before launch. Expected move: a separate `apps/ops` with SSO.

### D-011 · Documented deviations from the PRD for Parts 1–3
Accepted for development and the pilot; each must be closed before launch where noted.

| Deviation | Close before |
|---|---|
| Sessions and rate limits in Postgres (D-008) | Load test |
| No CAPTCHA yet (no provider chosen) | Launch |
| Permissions as a checked table in code, not a policy engine | Revisit if rules outgrow the table |
| Uploads go through the API to encrypted local disk, not presigned object storage | Launch |
| Virus scan is a stand-in | Launch |
| Customer consent by link only, no OTP; SMS shows in the test inbox | Launch (see SEC-01) |
| No pincode lookup yet | Launch |
| Co-applicants not built | Part 7 |
| Reference ID emailed rather than shown on screen, so sign-up can't reveal who has an account | Permanent |
| Lenders come from seed data until the ops lender screen exists | Launch |
| The API refuses to start in production until real providers are connected | Permanent safeguard, lifted per provider |

---

## Review decisions (9 November 2026)

Three reviews of commit `7c2047a`: code review, architecture review and security review.

### D-012 · Fix the P0 review findings before starting Part 4
- **Decision:** before any Part 4 work, fix SEC-01, SEC-02, SEC-03, SEC-04, BUG-01, BUG-02, BUG-03, BUG-04, STD-05 and DX-01.
- **Why:** Part 4 builds directly on the case, consent, notification and upload code these touch; fixing them later
  means fixing them in more places.

### D-013 · Start Part 4 with the Case lifecycle and Notifications modules — Proposed
- **Decision:** the first Part 4 PRs create one module that owns every case transition (allowed moves, who may act,
  reasons, history, audit, notification intent) and one Notifications module with an outbox.
- **Why:** Part 4 is made of transitions; without one owner, each transition would copy the same four steps by hand.
- **Not chosen:** granting the app direct `UPDATE` on cases; a database function that checks a table of allowed moves is preferred.
- **Later, in order:** Money type and partner KYC standing before Part 5; one definition per product before Part 7.

### D-014 · Block case creation until partner KYC is approved — Proposed (SPEC-01)
- **Context:** the PRD allows cases before approval and blocks only invoices; the code blocks cases too.
- **Recommendation:** keep the code's behaviour and update the PRD. Safer, and avoids cases from unverified partners.

### D-015 · GST certificate required only for GST-registered partners — Proposed (SPEC-02)
- **Context:** the PRD lists it as required for everyone; the code makes it optional because unregistered partners don't have one.
- **Recommendation:** accept, and make it required when the partner says they are GST-registered.

### D-016 · Customer consent required before submitting a case — Proposed (SPEC-03)
- **Context:** built but not in the PRD.
- **Recommendation:** accept into the PRD once SEC-01 is fixed.

### D-017 · Partner agreement step and business contact fields — Proposed (SPEC-04, SPEC-05)
- **Recommendation:** accept both into the PRD.

### D-018 · Does a disbursed case block a new one for the same customer and product? — Proposed (SPEC-06)
- **Context:** the two duplicate checks currently disagree (BUG-04).
- **Recommendation:** no, a disbursed case is closed. Check how this interacts with top-up and balance-transfer loan types.

### D-019 · Browser tests stay on the dev server for now — Deferred (DX-04)
- **Context:** on slow machines the dev server's large bundles make tests time out; a production build is faster and closer to real use.
- **Why deferred:** one test reads the dev inbox page, which is deliberately disabled in production builds.
- **Trigger to revisit:** when browser tests are added to CI (DX-05).

### D-020 · Keep the well-designed modules as they are — Accepted
The database helpers (`withTenant`, `withAuth`, `withOps`), the audit module, the upload and signed-link pipeline,
the permission rules and the shared product validation were reviewed and should **not** be refactored. Future
architecture reviews shouldn't re-propose changes to them without new evidence.

### D-021 · Parts 4–6 were built before the review; the fixes go on top — Proposed
- **Context:** D-012 says fix the P0 list before Part 4, but Parts 4–6 already existed on a local branch when the review arrived.
- **Decision:** keep that work and apply every fix on top of it, so the fixes also cover the new code (for example two more places that sent mail without checking the result).
- **Not chosen:** throwing Parts 4–6 away and rebuilding them after the fixes; it would redo working, tested code.
- **Owner:** both, needs the product owner's agreement · **Date:** 2026-11-09

### D-022 · The outbox lives in Postgres, encrypted, cleared when done — Accepted (ARCH-02, BUG-02, BUG-03)
- **Decision:** emails, texts and file deletions are written to an `outbox` table in the same transaction as the change. A first attempt runs right after the commit, then a timer retries with back-off (30 s doubling, 6 attempts). Payloads are encrypted and wiped once an item is sent or has failed for good. Only database functions can read or update the table; the worker uses the ops connection.
- **Why:** nothing is sent for a change that rolled back, and nothing is lost silently. No new infrastructure is needed before launch.
- **Not chosen:** a message broker (another system to run, for 500 users); sending straight after commit with no record (the old behaviour).
- **Trigger to revisit:** the load test (with D-008), or if delivery volume needs a separate worker process.
- **Owner:** lead engineer · **Date:** 2026-11-09

### D-023 · The case status guard is a trigger, not a transition function — Accepted (ARCH-01)
- **Decision:** a `BEFORE UPDATE` trigger on cases refuses any status change that is not in the `case_transition` table, any status change without a new version, and a Relook that does not return to where it came from. A test checks the table matches the rules in code.
- **Why:** it gives the same guarantee as a `transition_case()` function (app code can't skip a stage), while letting a disbursal or a sanction update their own columns in the same statement.
- **Not chosen:** a single database function for every move. It would need a parameter for every column any move might set.
- **Owner:** lead engineer · **Date:** 2026-11-09

### D-024 · Consent needs a one-time code to the customer's phone — Accepted (SEC-01)
- **Decision:** the consent link and a 6-digit code both go only to the customer's mobile number. Consent is recorded with channel `otp`. It is void if the phone, email or PAN changes. Five wrong codes lock the code; at most five codes per link.
- **Until an SMS provider is chosen,** texts appear in the dev inbox. That is a launch item (D-011).
- **Owner:** lead engineer · **Date:** 2026-11-09

### D-025 · Car loan limits — Proposed (GAP-04)
- **Decision:** for Used Car and Loan Against Car, the loan can't be more than 100% of the valuation; the wizard warns above 85%; the car can't be more than 12 years old when the loan ends. All three live in the product definition and are checked by the API.
- **Product owner to confirm the numbers.** Changing them is a one-line edit to the product file.
- **Owner:** product owner · **Date:** 2026-11-09

### D-026 · Idempotency keys are honoured on every signed-in POST, not required — Accepted (STD-08)
- **Decision:** when a signed-in POST carries an `Idempotency-Key`, a repeat with the same body gets the first answer back, and the same key with a different body is refused. A failed request frees its key. Keys are per user and route, and kept 24 hours. Uploads keep their own replace rules.
- **Not chosen:** making the header compulsory everywhere. It would break existing callers for little gain; the routes that create money or cases already require it.
- **Owner:** lead engineer · **Date:** 2026-11-09

### D-027 · The database's duplicate rule waits for D-018 — Deferred (BUG-04)
- **Decision:** the app's "open case" check now uses the one list in the lifecycle module. The database's cross-partner check is unchanged until the product owner decides D-018, because either fix changes behaviour.
- **Trigger to revisit:** D-018 is decided.
- **Owner:** lead engineer · **Date:** 2026-11-09

### D-028 · Lists page in the API; screens still show the first page — Deferred (STD-06)
- **Decision:** users, ops partners and drafts lists now return a cursor. The screens show the first page (the same size as before) and don't yet have a "load more" control.
- **Trigger to revisit:** any organisation with more than 100 users, or more than 100 partners waiting for review.
- **Owner:** lead engineer · **Date:** 2026-11-09

### D-029 · CI runs the browser tests against a production build — Accepted (DX-04, DX-05)
- **Decision:** a CI job starts the database, seeds it, builds the web app and runs every browser test against `next start`. Tests read mail through the API, not the dev inbox page. Timeouts come from environment variables.
- **Supersedes:** D-019.
- **Owner:** lead engineer · **Date:** 2026-11-09

---

## Fix log

One row per finding as it is closed. Link the PR. A finding that is deferred or rejected gets a decision entry above.

| Finding | Summary | Outcome | PR / commit | QA sign-off | Date |
|---|---|---|---|---|---|
| SEC-01 | Customer consent channel | Fixed (D-024) | branch fix/review-findings | | 2026-11-09 |
| SEC-02 | Audit staff reads of partner data | Fixed | branch fix/review-findings | | 2026-11-09 |
| SEC-03 | Encrypt identifying product details | Fixed | branch fix/review-findings | | 2026-11-09 |
| SEC-04 | Dev mailbox reachable only on localhost | Fixed | branch fix/review-findings | | 2026-11-09 |
| BUG-01 | Draft edit conflicts | Fixed | branch fix/review-findings | | 2026-11-09 |
| BUG-02 | File changes after commit | Fixed (D-022) | branch fix/review-findings | | 2026-11-09 |
| BUG-03 | Notification failures | Fixed (D-022) | branch fix/review-findings | | 2026-11-09 |
| BUG-04 | One definition of an open case | Deferred (D-027) | | | |
| STD-05 | Audit draft edits | Fixed | branch fix/review-findings | | 2026-11-09 |
| DX-01 | Rename the env setup script | Fixed | branch fix/review-findings | | 2026-11-09 |
| ARCH-01 | Case lifecycle owns every move | Fixed (D-023) | branch fix/review-findings | | 2026-11-09 |
| ARCH-02 | Notifications outbox | Fixed (D-022) | branch fix/review-findings | | 2026-11-09 |
| ARCH-03 | One definition per product | Fixed | branch fix/review-findings | | 2026-11-09 |
| ARCH-04 | Customer consent module | Fixed | branch fix/review-findings | | 2026-11-09 |
| ARCH-05 | "May this partner trade?" | Fixed | branch fix/review-findings | | 2026-11-09 |
| ARCH-06 | Applicant data and Money | Partly fixed: Money type and sealed product details; applicant fields still sealed column by column | branch fix/review-findings | | 2026-11-09 |
| STD-06 | Paging | Partly fixed (D-028) | branch fix/review-findings | | 2026-11-09 |
| STD-08 | Idempotency on every POST | Fixed (D-026) | branch fix/review-findings | | 2026-11-09 |
| GAP-01 | Data-driven product catalogue | Fixed (with ARCH-03) | branch fix/review-findings | | 2026-11-09 |
| GAP-02 | Lenders mapped to loan types | Fixed | branch fix/review-findings | | 2026-11-09 |
| GAP-03 | Reference ID in the wizard header | Fixed | branch fix/review-findings | | 2026-11-09 |
| GAP-04 | Car limits in the product definition | Fixed, numbers Proposed (D-025) | branch fix/review-findings | | 2026-11-09 |
| DX-02 | Postgres logs on failure | Fixed | branch fix/review-findings | | 2026-11-09 |
| DX-03 | Refuse a second database start | Fixed | branch fix/review-findings | | 2026-11-09 |
| DX-04 | Configurable browser test timeouts | Fixed (D-029) | branch fix/review-findings | | 2026-11-09 |
| DX-05 | Browser tests in CI | Fixed (D-029) | branch fix/review-findings | | 2026-11-09 |
| DX-06 | Turbo parallel flag | Fixed | branch fix/review-findings | | 2026-11-09 |
| DX-07 | Apple Silicon Node note | Fixed | branch fix/review-findings | | 2026-11-09 |
| STD-01, 02, 03, 04, 07 | Module boundaries and tidy-ups | Partly fixed in passing; the rest open | | | |

**Outcome values:** `Open` · `Fixed` · `Deferred (D-NNN)` · `Rejected (D-NNN)` · `Won't fix (D-NNN)`

---

## Template for a new entry

```markdown
### D-NNN · <decision in a few words> — <Status>
- **Decision:** what we will (or won't) do.
- **Context:** what prompted it; finding ID if any.
- **Why:** the reason that would matter to someone re-opening this later.
- **Not chosen:** the alternatives and why not.
- **Trigger to revisit:** (for Deferred) what event or date re-opens it.
- **Owner:** product owner / lead engineer · **Date:** YYYY-MM-DD
```
