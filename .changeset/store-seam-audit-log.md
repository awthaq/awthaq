---
"@awthaq/core": minor
"@awthaq/ports": minor
"@awthaq/sql": minor
"@awthaq/test": minor
---

`AuditLog` is written once, over a new `AuditLogStore` port (ADR-EA-041, plan 02 phase 2).

- `@awthaq/ports` gains `AuditLogStore` (`append`, `select`, `pageAfter`, `rewriteReferencing`, `deleteBefore`, each atomic by contract) with a `Ref` adapter, `layerMemory`. `@awthaq/sql` gains `AuditLogStoreSql.layer` over `AuditLogRepository`. `@awthaq/core`'s `AuditLog` gains `layer` (requires only `AuditLogStore`); `AuditLog.layerMemory` and `layerSql` stay as aliases until the persistence bundles land.
- `@awthaq/test` gains `StoreContract.auditLog`, the cases an `AuditLogStore` adapter must pass, run on the `Ref`, SQLite, SQLite WAL file and (`pnpm test:pg`) Postgres adapters.
- Behaviour (every backend, identically): recording an event whose `eventId` is already stored is ignored instead of failing (it was an unhandled `UniqueViolation`, reported as `StoreUnavailable`, on SQL); `list` decodes only the rows its filter selects, so one undecodable row no longer fails every listing (memory); `replay` pages in byte order of `id` (Postgres `COLLATE "C"`); `pseudonymizeActor` is all-or-nothing and takes the rows `FOR UPDATE` on Postgres; `purge` with an empty `eventTags` allow-list deletes nothing (it failed on Postgres); `replay` dies on a `batchSize` that is not a positive integer.
- `@awthaq/sql` repository: `AuditLogRepository.insert` is replaced by `insertIfAbsent` (idempotent on `id`, answers `boolean`), and the `payload` is the JSON text (the row model no longer decodes it), as is the argument of `rewrite`; `listReferencing` takes an optional `{ lock }`.

Migration: an application that calls `AuditLog.record` twice with one event no longer sees an error. A host that reads `AuditLogRepository` directly passes and receives `payload` as JSON text and calls `insertIfAbsent`. `AuditLog.purge({ eventTags })` still takes any array; an empty one now means "no tag", not an error. BEH-EA-100, BEH-EA-102.
