---
"@awthaq/ports": minor
"@awthaq/sql": patch
"@awthaq/core": patch
"@awthaq/test": minor
---

The substrate of the domain store seam (ADR-EA-041), with no behaviour change.

- `@awthaq/ports` gains `Ids` (the `UserId`, `AccountId`, `SessionId`, `VerificationTokenId` and `E164` brands, moved down from `@awthaq/sql`), `Store` (`StoreUnavailable`, `Consistency`, `ReadOptions`), `PruneExpired` (the in-memory eviction, moved from core) and `Tenant.resolve` (the tenant-stamp rule over an optional explicit tenant). It now depends on `@awthaq/api`.
- `@awthaq/sql` re-exports the id brands and `Consistency`/`ReadOptions` (so `SqlModels.UserId` and `ReadRouting.ReadOptions` keep compiling) and gains `SqlStore` (`write`, `read` and `drainBatches`, the wrapper every SQL store adapter runs a primitive through).
- `@awthaq/test` gains `StoreContract` (`Case`, `run`, `race`): the runner for the contract each store port's adapters must pass.

Migration: none.
