---
ID: "PIL-003"
Title: "No expired-session reaper, and list caps at the 200 oldest rows"
Level: medium
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:418"
Auditor: "pilcrow"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# PIL-003 — No expired-session reaper, and list caps at the 200 oldest rows

`MEDIUM` · `correctness` · `core` · reported by **pilcrow (pilcrowOnPaper) — Creator of Lucia Auth** (`pilcrow`)

Status: **resolved**

## Summary

verify fails an expired session with SessionExpired but never deletes the row, and no sweep job, lazy-purge, or deleteExpired primitive exists anywhere (the repository Shape has no such method; admin's ImpersonationRecords even documents that 'nothing here observes a session's hard expiry'). Rows therefore accumulate forever. listByUser orders by createdAt ASC and Sessions.layerSql passes LIST_PAGE_SIZE = 200, so for an account with >200 rows — reachable purely by time, since nothing is ever deleted — the newest, live sessions fall outside page one: the device list shows stale devices and omits current ones, and @awthaq/jwt's verifyLive liveness check (built on Sessions.list) can then reject a perfectly valid session's JWT, force-logging the user.

## Evidence

Source: `packages/core/src/Sessions.ts:418`

```
const LIST_PAGE_SIZE = 200;
```

## Recommended fix

Delete the row on verify's expiry paths (cheap, self-healing) and/or add a periodic sweep (DELETE WHERE absolute_expires_at < now) as a Layer; then either order the device list newest-first or make jwt's liveness check a direct findById on the session row instead of a page-capped list scan.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: session fundamentals
- Full dossier: [`pilcrow`](../../.reports/pilcrow/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Redundant assertion after sound narrowing in session supersedes path](low/AH-007-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`AGA-004` — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate](medium/AGA-004-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BO-005` — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login](medium/BO-005-balazs-orban.md) `_(balazs-orban, medium)_`
- [`BAM-003` — Session cutover invalidates every live better-auth session with no bridge](high/BAM-003-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`DRS-004` — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning](medium/DRS-004-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ECF-007` — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard](low/ECF-007-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-008` — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim](low/EEM-008-effect-error-management-specialist.md) `_(effect-error-management-specialist, low)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `session-list-correctness`. Duplicate of `ESS-005-effect-stream-specialist` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:641`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.
