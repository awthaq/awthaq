---
"@awthaq/core": minor
"@awthaq/ports": minor
"@awthaq/sql": minor
"@awthaq/test": minor
---

`Sessions` is written once, over a new `SessionStore` port (ADR-EA-041, ADR-EA-014, plan 02 phase 6).

- `@awthaq/ports` gains `SessionStore` (`insert`, `get`, `rotate`, `flagReuse`, `remove`, `removeForUser`, `listLive`, `reauthenticate`, `purgeExpired`, each atomic by contract) with a `Ref` adapter, `layerMemory`, and the shared `isLive`, `evictionOrder` and `unionMethods`. `@awthaq/sql` gains `SessionStoreSql.layer` over `SessionsRepository` and `ReadRouting.captureTokenOn`. `@awthaq/core`'s `Sessions` gains `layer` (requires `SessionStore`, `Crypto` and `AuthEvents`); `Sessions.layerMemory` and `layerSql` stay as aliases until the persistence bundles land. A third-party backend (a KV `SessionStore`, ADR-EA-014) implements the nine primitives and passes `StoreContract.sessions`.
- `@awthaq/test` gains `StoreContract.sessions`, run on the `Ref`, SQLite, SQLite WAL file and (`pnpm test:pg`) Postgres adapters.
- Behaviour, in every backend: a rotation never touches a tombstoned row, and a call that loses its compare-and-swap re-applies liveness to the row it finds (it used to authenticate whatever was there); `list` is bounded by `LIST_LIMIT` in memory too (it was unbounded); the SQL adapter's session writes capture the replica causal token, so a revoke followed by an eventual device list is read-your-writes; a memory composition prunes an expired row once its map is large, so such a row is `SessionNotFound` rather than `SessionExpired`.
- `@awthaq/sql` repository: `deleteAllForUserExcept` and `deleteAllByUser` resolve to the number deleted, `touch` refuses a tombstoned row, `listLiveIds` answers branded ids.

Migration: none for application code; `Sessions.list`'s `options` type is `Store.ReadOptions` from `@awthaq/ports` (the same shape, so `ReadRouting.ReadOptions` still works). BEH-EA-052, BEH-EA-053, BEH-EA-054.
