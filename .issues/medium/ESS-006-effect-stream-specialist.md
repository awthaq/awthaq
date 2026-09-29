---
ID: "ESS-006"
Title: "Admin impersonation history query is unpaginated and unstreamed: SELECT * ordered, whole table per call"
Level: medium
Category: "performance"
Status: ready-for-agent
Package: "admin"
Source: "packages/admin/src/ImpersonationRecords.ts:252"
Auditor: "effect-stream-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-006 — Admin impersonation history query is unpaginated and unstreamed: SELECT * ordered, whole table per call

`MEDIUM` · `performance` · `admin` · reported by **Effect Stream Specialist** (`effect-stream-specialist`)

Status: **ready-for-agent**

## Summary

Impersonation history is append-only security data that grows without bound, and the SQL layer's list loads every row into a ReadonlyArray per call (the memory layer likewise sorts the entire HashMap, ImpersonationRecords.ts:173). This violates the spirit of BEH-EA-036's own rationale ('offset pagination forces the database to walk and discard... No repository's public interface MAY accept an offset') — here there is no pagination at all, so cost grows linearly with total history, and Admin.ts:178's list handler maps it all into DTOs per admin request. This is exactly the 'batched exports for the admin plugin' flow the event/pagination streaming design is meant to serve; the same SessionsRepository page() pattern (keyset on (startedAt, id)) slots in directly.

## Evidence

Source: `packages/admin/src/ImpersonationRecords.ts:252`

```
      Request: Schema.Void,
      Result: ImpersonationRow,
      execute: () => sql`SELECT * FROM admin_impersonation ORDER BY startedAt DESC`,
```

## Recommended fix

Add keyset cursor pagination to ImpersonationRecordsShape.list mirroring SessionsRepository.listByUser, and expose history export as a Stream (or cursor-chained Effect) so a dashboard pages instead of materializing the full table.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: Stream & backpressure
- Full dossier: [`effect-stream-specialist`](../../.reports/effect-stream-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-005` — Zero tamper-evidence on the one durable audit table — history is rewritable by anyone with SQL access](medium/ALF-005-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`ESA-008` — The 'expired' ended-by path is declared but never produced, so durable impersonation audit episodes are never closed by expiry](low/ESA-008-event-sourcing-audit-trail-specialist.md) `_(event-sourcing-audit-trail-specialist, low)_`
- [`IDS-002` — No tenant or organization scoping anywhere in the impersonation path](medium/IDS-002-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-004` — endedBy="expired" is declared but nothing ever sets it; audit trail reports dead episodes as active](medium/IDS-004-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`JR-011` — Naturally-expired impersonation episodes stay 'active' forever: the expired EndedBy value has no producing code path](info/JR-011-justin-richer.md) `_(justin-richer, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `admin-impersonation-lifecycle`. Evidence at HEAD ec065a7: `packages/admin/src/ImpersonationRecords.ts:249`. Fix: Keyset-paginate the impersonation history on (startedAt, id), newest-first, in both layers and on the wire. (effort M). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.
