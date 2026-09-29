---
ID: "IDS-002"
Title: "No tenant or organization scoping anywhere in the impersonation path"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "admin"
Source: "packages/admin/src/ImpersonationRecords.ts:45"
Auditor: "impersonation-delegation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# IDS-002 — No tenant or organization scoping anywhere in the impersonation path

`MEDIUM` · `security` · `admin` · reported by **Impersonation & Delegation Specialist** (`impersonation-delegation-specialist`)

Status: **ready-for-agent**

## Summary

The audit record, the gate input, and the list endpoint carry no tenant/organization dimension: records are keyed only by user and session ids, `list` returns every episode in the deployment to any gate-passing caller (Admin.ts:292-302), and forceStop can end any episode regardless of tenant. The organization plugin has zero references to impersonation or actingAs (grep across packages/organization), so a host that enables impersonation gets cross-tenant capability by default with no seam at which to restrict it - compounding IDS-001 since even a target-aware gate today would have no tenant context to compare.

## Evidence

Source: `packages/admin/src/ImpersonationRecords.ts:45`

```
readonly adminUserId: UserId;
  readonly targetUserId: UserId;
  readonly sessionId: string;
```

## Recommended fix

Thread the target's org/tenant (or an explicit scope parameter) into the gate input and the record schema, and scope `list`/`forceStop` to the caller's tenant unless explicitly privileged.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 71/100), domain: Impersonation & Delegation
- Full dossier: [`impersonation-delegation-specialist`](../../.reports/impersonation-delegation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-005` — Zero tamper-evidence on the one durable audit table — history is rewritable by anyone with SQL access](medium/ALF-005-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`ESS-006` — Admin impersonation history query is unpaginated and unstreamed: SELECT * ordered, whole table per call](medium/ESS-006-effect-stream-specialist.md) `_(effect-stream-specialist, medium)_`
- [`ESA-008` — The 'expired' ended-by path is declared but never produced, so durable impersonation audit episodes are never closed by expiry](low/ESA-008-event-sourcing-audit-trail-specialist.md) `_(event-sourcing-audit-trail-specialist, low)_`
- [`IDS-004` — endedBy="expired" is declared but nothing ever sets it; audit trail reports dead episodes as active](medium/IDS-004-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`JR-011` — Naturally-expired impersonation episodes stay 'active' forever: the expired EndedBy value has no producing code path](info/JR-011-justin-richer.md) `_(justin-richer, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `admin-impersonation-gate-target`. Evidence at HEAD ec065a7: `packages/admin/src/ImpersonationRecords.ts:43`. Fix: Stamp the ambient tenant (ticket 18's TenantContext) on every episode and scope list/forceStop to it; cross-tenant access only through the superadmin predicate from ticket 19. (effort M). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.
