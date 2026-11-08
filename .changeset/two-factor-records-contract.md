---
"@awthaq/two-factor": patch
---

The two-factor record stores have RecordsContract suites (plan 25 ticket 21, ADR-EA-041 decision 9, BEH-EA-264/265):

- Concurrent recovery-code regenerations leave exactly one set. Before, on Postgres, two regenerations racing each other could each delete the old set and insert their own, leaving both new sets valid. The SQL `TwoFactorRecoveryCodes.replaceAll` now runs under the user's `SqlStore.atomically` lock (`two_factor_recovery_code:user:<id>`), and `deleteAllByUser` takes the same lock.
- `TwoFactorSecrets` (`upsertPending`, `confirm`, `advanceLastUsedStep`) and `TwoFactorRecoveryCodes` (`replaceAll`, `markUsed`) are proven atomic by 8-way race cases on memory and SQL, Postgres included under `pnpm test:pg`.

Migration: a custom adapter through `@awthaq/two-factor`'s `TwoFactorRecoveryCodes` must serialise `replaceAll` per user, so that concurrent calls leave exactly one whole set (memory: one `Ref.update`; SQL: the delete and the inserts in one transaction under a per-user lock).
