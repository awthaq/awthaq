---
"@awthaq/qadi": patch
---

Concurrent `UserClaims` merges keep every key (plan 24 C7, plan 25 ticket 24, BEH-EA-161). Before, on Postgres, two merges each read the same claims document inside their own transaction and the second upsert dropped the first one's key, while both published `auth.user.claimsUpdated`. The SQL `UserClaimsRecords.modify` now runs under the user's `SqlStore.atomically` lock (`qadi_claims:user:<id>`), so each merge sees the one before it and each event names the keys its own write changed. The store has a RecordsContract suite (ADR-EA-041 decision 9). `@awthaq/qadi` now depends on `@awthaq/sql`.

Migration: a custom adapter through `@awthaq/qadi`'s `UserClaimsRecords` must make `modify` atomic per user (memory: one `Ref.modify`; SQL: the read and the write under a per-user lock), so that concurrent changes never lose one another.
