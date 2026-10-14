---
"@awthaq/magic-link": minor
---

A magic link or email code is no longer burned when completing the sign-in fails on an outage or a defect; it can be presented again, and an email code keeps its attempt budget. A refusal after a valid presentation (a `BeforeSignIn`/`BeforeSignUp` veto, a suspended user, a second-factor divert) still spends it (BEH-EA-269, BEH-EA-273, ADR-EA-039). `MagicLink.verify` and `EmailOtp.verify` redeem through `Verification.redeem` with `commitUnlessUnavailable`.

Migration: none for callers. A `BeforeSignIn`/`BeforeSignUp`/`BeforeSessionIssue` tap now runs inside the sign-in's transaction; a tap that writes through a different database client than the composition's may wait on the write lock.
