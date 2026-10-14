---
"@awthaq/magic-link": patch
---

Magic link and email OTP create a first-time user through `SignUp` (ADR-EA-038): `BeforeSignUp` vets it, the user is created already verified, and `auth.user.created`/`AfterSignUp` run only after it commits.

Migration: `MagicLink` and `EmailOtp` now declare `SqlTransaction.SqlTransaction` among their ports, and the host's `Accounts` is required by the sign-up path.
