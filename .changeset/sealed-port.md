---
"@awthaq/ports": minor
"@awthaq/sql": minor
---

`Sealed` (the value, `Unreadable`, `plain`, `openOption`, `optional`, `orDie`, `option`) moves to `@awthaq/ports`; `SealedColumn` re-exports it unchanged. `SealedColumn.Deployed` and `SealedColumn.sweepDeployed` sweep every sealed column a composition writes, and `CoreSealedColumns` declares core's six. A lazy re-seal now runs in a savepoint, so a failed one no longer aborts an enclosing Postgres transaction (ADR-EA-019 rev 1.3, BEH-EA-324).

Migration: none.
