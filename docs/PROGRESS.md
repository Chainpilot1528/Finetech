# Vittora progress

Last updated: 8 November 2026. The percentages are estimates based on how much work each part needs.

**Overall: about 63% of the full project.** Parts 1 to 6 are built, but each counts for less than its full
weight until the tester signs it off.

| Part | Weight | Done | Status |
|---|---:|---:|---|
| 0. Decisions and PRD | 3% | 3% | Done. Licence and lender questions still need confirming |
| 1. Foundation | 12% | 10% | Built, waiting for tester sign-off |
| 2. Partner onboarding | 10% | 8% | Built, waiting for tester sign-off |
| 3. Create Case | 15% | 12% | Built, waiting for tester sign-off |
| 4. Case tracking | 17% | 14% | Built, waiting for tester sign-off |
| 5. Commissions | 12% | 10% | Built, waiting for tester sign-off |
| 6. Team and settings | 8% | 6% | Built, waiting for tester sign-off |
| 7. Remaining products | 13% | 0% | Not started |
| 8. Launch prep | 10% | 0% | Not started |

## Differences from the plan
- Sessions and sign-in limits use Postgres, not Redis (ADR 0004)
- CAPTCHA is not built yet because no provider is chosen
- Permissions use a checked table in code rather than a separate policy engine
- Modules live in `apps/api/src/modules` until the worker app needs them
- The ops console lives at `/ops` inside the web app, with its own sign-in and database role, not a separate app with SSO
- Uploads go through the API, not presigned URLs, and are stored encrypted on local disk
- The virus scan is a stand-in that only catches the EICAR test file
- Customer consent uses a link only, not OTP. There is no SMS provider yet, so SMS appears in the test inbox
- Pincode does not fill city and state yet, because no lookup provider is chosen
- Co-applicants are not built yet. They come with Education Loan in Part 7
- Registration emails the Reference ID, rather than showing it on screen, so the form can't reveal who has an account
- Lenders come from seed data until the ops lender screen is built
- Emails go out straight after the change commits, not through an outbox, so a failed send is not retried
- Case export runs straight away and stops at 5,000 rows, rather than running as a background job above that
- Download PDF on cases and invoices uses the browser's print dialog
- Transitions, disbursals and invoice actions are protected by If-Match, not Idempotency-Key. Notes and drafts use Idempotency-Key
- Needs Action counts RELOOK cases only, because there is no separate pending-documents state
- The disbursal checklist is one confirmation tick, because the PRD doesn't list its items
- Customer Approved checks the consent given at case creation, not a separate approval of the sanctioned terms
- Clawback on foreclosure inside the rate card window is not built. Reversal clawbacks are
- A clawback is for the full net amount paid, including GST
- GST and TDS rates live in a table with no screen. TDS is seeded at 2% and must be confirmed by an accountant
- Help articles live in the page code, not in Markdown files
- In-House lifecycle, bank allocation, bureau pulls and lending policies are not built (P2)
- No ops screens yet for lenders, partner feature flags or audit search
- Staff can't see customer names or contact details. Whether ops needs them to work a case is an open decision

## The app refuses to start in production
Local storage, the stand-in virus scan and the test inbox must never reach real customers, so the API
refuses to boot in production mode until real providers are connected.

## Not checked yet
- Real email and SMS sending, and the live breached-password service
- Safari, Firefox and real phones
- Load testing
- Purging drafts after 30 days is not built
- Ops and Finance screens at phone width
