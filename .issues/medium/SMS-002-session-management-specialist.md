---
ID: "SMS-002"
Title: "Session list returns expired sessions and nothing ever reaps dead rows"
Level: medium
Category: "correctness"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:383"
Auditor: "session-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SMS-002 — Session list returns expired sessions and nothing ever reaps dead rows

`MEDIUM` · `correctness` · `sql` · reported by **Session Management Specialist** (`session-management-specialist`)

Status: **resolved**

## Summary

BEH-EA-054 specifies a list of a user's own *live* sessions, but listByUser has no expiry predicate and the memory layer's list (packages/core/src/Sessions.ts:386) filters only on userId, so expired rows appear in the device list forever. Nothing deletes expired rows: verify fails them lazily but leaves the row in place, and a repo-wide search finds no sweep/purge/cleanup anywhere. Consequences: the device list fills with dead entries users cannot tell from live ones (the DTO carries no expired flag), the sessions table grows without bound, and the memory layer's Ref leaks every issued session until process end.

## Evidence

Source: `packages/sql/src/Repositories.ts:383`

```
? sql`SELECT * FROM sessions WHERE "userId" = ${request.userId}
                  ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit}`
```

## Recommended fix

Add an expiry predicate (idleExpiresAt > now AND absoluteExpiresAt > now) to listByUser and the memory list, and add a scheduled reaper (bulk DELETE of expired rows) as a Layer, or delete-on-sight when verify observes SessionExpired.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: session lifecycle
- Full dossier: [`session-management-specialist`](../../.reports/session-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-002` — No bulk-invalidate, list, or count primitives anywhere in the Verification stack](high/BCR-002-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`DRS-005` — Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding](medium/DRS-005-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ERAS-006` — SQL repositories are structurally driver-neutral, but no edge-viable SqlClient story exists or is documented](info/ERAS-006-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`EOTS-008` — Hand-written SQL queries bypass the spanPrefix spans that repository CRUD gets](medium/EOTS-008-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`ESR-001` — AccountsRepository.update is a non-transactional read-modify-write that can lose concurrently refreshed tokens](medium/ESR-001-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-003` — Email case-folding relies on lower() whose semantics diverge between SQLite and Postgres and from the app-level normalization](medium/ESR-003-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-004` — Decrypt failures are collapsed to fiber defects, so one unreadable row poisons whole result-set operations](medium/ESR-004-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-005` — findByIdentifier cannot use the identifier index for consumed history and sorts unindexed](low/ESR-005-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- … 19 more findings touch `packages/sql/src/Repositories.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-list-liveness-and-pagination`. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:435`. Fix: Filter expired rows out of the device list in both layers. Delegate physical deletion to ticket 30's `Retention.sweep` (CSG-003, cross-slice) rather than inventing a second reaper. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Expiry filtered out of the device list in both layers: SessionsRepository.listByUser now takes the caller clock 'now' and applies absoluteExpiresAt > now AND idleExpiresAt > now; layerMemory.list applies the same isLiveAt predicate. Tests: core Sessions.test.ts idle-expired/absolute-expired not listed (both layers) and sql Repositories.test.ts 'SMS-002: listByUser omits absolute-expired, idle-expired and tombstoned rows'. Physical deletion of dead rows is deliberately not done here: it stays with CSG-003's Retention.sweep (still open, other program).
