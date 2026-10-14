---
"@awthaq/password": minor
---

`Password.confirmReset`, `verifyEmail` and `confirmEmailChange` redeem their tokens through `Verification.redeem` (ADR-EA-039, BEH-EA-058). In an in-memory composition a failed attempt (a `BeforeCredentialReset` veto, `SecondFactorRequired`, a crash) now leaves the token usable, exactly as over SQL (BEH-EA-259): retry the same token with `secondFactorCode`. A database failure while committing one of them is now the typed `StoreUnavailable` (503) instead of a defect (ADR-EA-028).

Migration: none for callers. A host that implemented its own `VerificationShape` (a test double) must add `redeem`; see the `@awthaq/core` changeset for `Verification.redeem`.
