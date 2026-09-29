---
ID: "OHS-007"
Title: "Deleted teams and organizations leave dangling active-context rows"
Level: low
Category: "correctness"
Status: resolved
Package: "organization"
Source: "packages/organization/src/ActiveContextRecords.ts:12"
Auditor: "organization-hierarchy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OHS-007 — Deleted teams and organizations leave dangling active-context rows

`LOW` · `correctness` · `organization` · reported by **Organization Hierarchy Specialist** (`organization-hierarchy-specialist`)

Status: **resolved**

## Summary

The header comment declares the orphaned-row gap only for session revocation, but the same table's activeTeamId/activeOrganizationId also survive team removal (removeTeam, Organization.ts:1833-1853) and full org deletion (delete_, lines 1152-1162 — activeContext is loaded at line 925 yet never cleared in the cascade). Sessions keep pointing at deleted entities: setActiveTeam validates membership only at set time, so a stale activeTeamId persists indefinitely, and getActiveMember/getActiveMemberRole against a deleted org fail with MembershipNotFound instead of a clean 'no active context' state.

## Evidence

Source: `packages/organization/src/ActiveContextRecords.ts:12`

```
Deliberately not cascade-deleted when its underlying session is revoked
— an orphaned row is harmless (the next read simply finds no matching
```

## Recommended fix

Extend both cascades to clear matching organization_active_context rows (or null the affected columns) for the deleted team/organization, and re-validate active context on read.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Org hierarchy modeling
- Full dossier: [`organization-hierarchy-specialist`](../../.reports/organization-hierarchy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`DRS-008` — organization_active_context is keyed by sessionId, coupling core sessions to plugin tables across any future shard boundary](low/DRS-008-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, low)_`
- [`MTI-001` — Tenant scoping is call-site discipline: the records layer is structurally unguarded](medium/MTI-001-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `org-active-context-lifecycle`. Duplicate of `CWM-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:1507`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `CWM-003-clerk-workos-migration-specialist` — closed by its fix (see that issue's Resolved comment).
