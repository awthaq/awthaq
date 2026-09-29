---
ID: "ESA-008"
Title: "The 'expired' ended-by path is declared but never produced, so durable impersonation audit episodes are never closed by expiry"
Level: low
Category: "compliance"
Status: resolved
Package: "admin"
Source: "packages/admin/src/ImpersonationRecords.ts:41"
Auditor: "event-sourcing-audit-trail-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESA-008 — The 'expired' ended-by path is declared but never produced, so durable impersonation audit episodes are never closed by expiry

`LOW` · `compliance` · `admin` · reported by **Event Sourcing & Audit Trail Specialist** (`event-sourcing-audit-trail-specialist`)

Status: **resolved**

## Summary

The type comment admits '"expired" ... names a value no code path in this plugin produces yet: nothing here observes a session's hard expiry' (ImpersonationRecords.ts:31-35). Consequence for the audit trail specifically: BEH-EA-215's durable rows accumulate episodes whose endedAt is null forever after the underlying session dies of old age — the audit record permanently disagrees with reality ('still active?' returns ghosts), and the AdminImpersonationStoppedEvent with endedBy:"expired" (AuthEvents.ts:67) can never fire. The best durable trail in the repo has a permanent open-endedness bug in its terminal states.

## Evidence

Source: `packages/admin/src/ImpersonationRecords.ts:41`

```
export type EndedBy = "self" | "forcedByAdmin" | "expired";
```

## Recommended fix

Add an expiry sweep (or lazy reconciliation on list/findBySessionId) that closes episodes whose session.expiredAt has passed, writing endedAt/endedBy:"expired" once, and publish the stopped event from the same path so the event log and the table agree.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: event durability & audit
- Full dossier: [`event-sourcing-audit-trail-specialist`](../../.reports/event-sourcing-audit-trail-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-005` — Zero tamper-evidence on the one durable audit table — history is rewritable by anyone with SQL access](medium/ALF-005-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`ESS-006` — Admin impersonation history query is unpaginated and unstreamed: SELECT * ordered, whole table per call](medium/ESS-006-effect-stream-specialist.md) `_(effect-stream-specialist, medium)_`
- [`IDS-002` — No tenant or organization scoping anywhere in the impersonation path](medium/IDS-002-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-004` — endedBy="expired" is declared but nothing ever sets it; audit trail reports dead episodes as active](medium/IDS-004-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`JR-011` — Naturally-expired impersonation episodes stay 'active' forever: the expired EndedBy value has no producing code path](info/JR-011-justin-richer.md) `_(justin-richer, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `admin-impersonation-lifecycle`. Duplicate of `IDS-004` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/admin/src/ImpersonationRecords.ts:41`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.
