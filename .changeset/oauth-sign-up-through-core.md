---
"@awthaq/oauth": patch
---

OAuth first login creates its user through `SignUp` (ADR-EA-038): `BeforeSignUp` vets it, the user, trusted-provider verification and provider account are one unit, and `auth.user.created`/`AfterSignUp` run only after it commits. A store outage while verifying the new user is now a typed `StoreUnavailable` instead of a defect.
