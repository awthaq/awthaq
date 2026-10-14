---
"@awthaq/password": minor
---

Password sign-up creates through `SignUp` (ADR-EA-038): the address is vetted by `BeforeSignUp` before the hash is computed, the user, password account and first session are one unit, and the first session is a cleared sign-in, so `BeforeSignIn`/`BeforeSessionIssue` run and `auth.user.signedIn` is published for it. `signUp` can now fail with `TwoFactorRequired` when a tap diverts the first session.

Migration: handle `TwoFactorRequired` from `signUp`; a `BeforeSessionIssue` tap now also sees the sign-up's first session.
