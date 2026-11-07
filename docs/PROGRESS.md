# Vittora progress

Last updated: 7 November 2026. The percentages are estimates based on how much work each part needs.

**Overall: about 13% of the full project.** Part 1 counts as 10 of its 12 points until it passes tester sign-off.

| Part | Weight | Done | Status |
|---|---:|---:|---|
| 0. Decisions and PRD | 3% | 3% | Done. Licence and lender questions still need confirming |
| 1. Foundation | 12% | 10% | Built and passing automated tests. Waiting for tester sign-off |
| 2. Partner onboarding | 10% | 0% | Not started |
| 3. Create Case | 15% | 0% | Not started |
| 4. Case tracking | 17% | 0% | Not started |
| 5. Commissions | 12% | 0% | Not started |
| 6. Team and settings | 8% | 0% | Not started |
| 7. Remaining products | 13% | 0% | Not started |
| 8. Launch prep | 10% | 0% | Not started |

## Part 1 test results
- API tests: 150 of 150 passing, against a real Postgres 16
- Browser tests: 9 of 9 passing in Chrome
- Lint, type checks and production build: passing

## Part 1 differences from the plan
- Sessions and sign-in limits use Postgres, not Redis (ADR 0004)
- CAPTCHA is not built yet because no provider is chosen. The delay and lockout are in place
- Permissions use a checked table in code rather than a separate policy engine
- Modules live in `apps/api/src/modules` until the worker app needs them
- Storybook, Chromatic and pre-commit hooks are not set up

## Not checked yet
- GitHub CI has never run, because nothing is pushed
- Real email sending and the live breached-password service
- Safari, Firefox and real phones
