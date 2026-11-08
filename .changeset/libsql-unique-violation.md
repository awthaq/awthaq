---
"@awthaq/sql": patch
---

`StoreFailure.orConflict` and `UserStoreSql.casIdentity` recognise a unique-constraint failure on libSQL. `@effect/sql-libsql` reports only the generic `SQLITE_CONSTRAINT` code, so a duplicate email arrived as a `ConstraintError` and a colliding `casIdentity` answered `StoreUnavailable` instead of `Taken`. `StoreFailure.isUniqueViolation` accepts `UniqueViolation` and a `ConstraintError` whose cause says "UNIQUE constraint failed"; `StoreContract` now runs on libSQL (`packages/test/test/StoreContract.libsql.test.ts`), so the README's driver claim is verified.
