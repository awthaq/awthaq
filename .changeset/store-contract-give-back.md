---
"@awthaq/test": patch
---

`StoreContract.verification` states the give-back (ADR-EA-039) on every adapter: a hold given back after its caller's transaction failed is live again, and a newer `upsertLive` or a `deleteByUser` in between wins. A store whose `settle` ignores `"returned"` now fails the contract.
