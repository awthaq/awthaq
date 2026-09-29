---
ID: "OHS-008"
Title: "Count queries load full row sets instead of using COUNT"
Level: low
Category: "performance"
Status: resolved
Package: "organization"
Source: "packages/organization/src/TeamRecords.ts:479"
Auditor: "organization-hierarchy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OHS-008 — Count queries load full row sets instead of using COUNT

`LOW` · `performance` · `organization` · reported by **Organization Hierarchy Specialist** (`organization-hierarchy-specialist`)

Status: **resolved**

## Summary

SQL-layer countTeamsByOrganization executes the full SELECT * (line 374) and counts rows in JS; it runs on every createTeam and removeTeam (Organization.ts:1779, 1839) to enforce maximumTeams/allowRemovingAllTeams. The same load-then-count pattern appears in MembershipRecords.countByOrganization. Harmless at small scale, but it deserializes every team row (through Schema) per mutation and grows linearly with team count for O(1) information.

## Evidence

Source: `packages/organization/src/TeamRecords.ts:479`

```
listTeamsByOrganizationQuery(organizationId).pipe(
        Effect.map((rows) => rows.length),
```

## Recommended fix

Use SELECT COUNT(*) (SqlSchema.findOne with a count column) for both count queries, keeping the memory-layer implementations as-is.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Org hierarchy modeling
- Full dossier: [`organization-hierarchy-specialist`](../../.reports/organization-hierarchy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`OHS-001` — Team model is flat: no parent pointers, closure structure, or hierarchy queries](high/OHS-001-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, high)_`
- [`OHS-003` — Duplicate team membership corrupts the durable memberCount and capacity caps](high/OHS-003-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, high)_`
- [`OHS-004` — Team membership carries no role; no per-team permission override exists](medium/OHS-004-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `org-sql-count-queries`. Duplicate of `MTI-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/organization/src/TeamRecords.ts:476`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → resolved.
