---
"@awthaq/core": minor
"@awthaq/ports": minor
"@awthaq/sql": minor
"@awthaq/test": minor
---

`Users` is written once, over a new `UserStore` port (ADR-EA-041, plan 02 phase 5).

- `@awthaq/ports` gains `UserStore` (`insertOrHolder`, `get`/`getByEmail`/`getByPhone`, `updateProfile`, `casIdentity`, `setStatus`, `delete`, `listPage`, `readFields`/`writeFields`, each atomic by contract) with a `Ref` adapter, `layerMemory`. `@awthaq/sql` gains `UserStoreSql.layer` over `UsersRepository`. `@awthaq/core`'s `Users` gains `layer` (provides `Users` and `UserRemoval`; requires `UserStore` and `Crypto`); `Users.layerMemory` and `layerSql` stay as aliases until the persistence bundles land.
- `@awthaq/test` gains `StoreContract.users` (and `StoreContract.userFieldColumns`, the declared-field columns a SQL runner adds to `users`), run on the `Ref`, SQLite, SQLite WAL file and (`pnpm test:pg`) Postgres adapters.
- Behaviour, in every backend: `verifyEmail`, `verifyPhone`, `promoteIdentity` and `changeEmail` are a compare-and-swap of the identity columns retried on a concurrent change (three attempts, then `StoreUnavailable`), so `AfterUserAttributesChanged` is announced exactly once and a lowering of `emailVerified` is announced from what the change really did (SQL announced from a stale read); `getFields` and `setFields` answer `UnknownUserField`, `UserFieldNotWritable` and `InvalidUserFieldValue` before `UserNotFound` (memory answered `UserNotFound` first); `setFields` bumps `updatedAt` and answers its own post-state from one statement (memory never changed `updatedAt` on any write, and could write fields for a user deleted mid-call); a user and its declared fields are deleted together; a `list` limit is clamped to 1 to 200 (a negative or non-integer limit was a defect or a wrong page); a duplicate `create` no longer aborts an enclosing Postgres transaction; a holder deleted between the two statements of `createOrGet` retries instead of dying.
- `Users.layerSql` now needs `Crypto` and `SqlClient` (the service mints the user id, like `Sessions` and `Verification`; the SQL model used to).
- `@awthaq/sql` repository: new `deleteReturning`, `casIdentity` and `writeFieldsReturning`; `updateProfile` and `setStatus` take an optional `updatedAt`.

Migration: provide `Crypto` (for example `NodeCrypto.layer`) to a composition that uses `Users.layerSql`; it already has it if it also uses `Sessions` or `Verification`. A test that read a memory user's `updatedAt` as unchanged after a write now sees it move. BEH-EA-041, BEH-EA-042, BEH-EA-048.
