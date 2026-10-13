---
"@awthaq/core": minor
---

`Verification.redeem({ identifier, value, use, onFailure })` claims a token and runs the state change it authorises in one transaction; a failed `use` gives the token back in both `layerMemory` (held-row compensation) and `layerSql` (rollback) (ADR-EA-039, BEH-EA-058). A miss is recorded once (the attempt a budgeted token is owed, `auth.token.replay` and its audit row), and `SqlError` from the transaction is the typed `StoreUnavailable("Verification.redeem")` (ADR-EA-028). `Verification.commitUnlessUnavailable` is the settlement for refusals that should spend the token while an outage gives it back. `consume` stays as the burn-first operation.

Migration: `Verification.layerSql` now requires `SqlClient` directly (the client its repositories run on); a composition that `provideMerge`s the SQL client under the repositories already satisfies it. A custom `VerificationShape` implementation (a test double) must add `redeem`.
