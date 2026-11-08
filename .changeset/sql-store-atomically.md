---
"@awthaq/sql": patch
"@awthaq/organization": patch
---

New `SqlStore.atomically(sql, key)`: runs one store primitive's read-modify-write in one transaction (a savepoint inside a caller's) that first takes an exclusive lock named `key`, `pg_advisory_xact_lock(hashtextextended(key, 0))` on Postgres, held until the outermost transaction ends. SQLite takes no lock (its client already runs one transaction at a time). It is how a record store keeps an invariant over several rows atomic under READ COMMITTED (ADR-EA-041 decision 9). `MembershipRecords`' SQL `remove`/`updateRole` now take their per-organization lock through it instead of an inline statement; the lock key is unchanged. `StoreFailure.orConflict` maps a SQLite primary-key clash to the domain conflict, like Postgres, and a test now pins it on the real driver.

Migration: none (additive).
