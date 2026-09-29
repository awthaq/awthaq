---
ID: "RZS-003"
Title: "Relationship graph is flat depth-0: no org hierarchy, no team nesting, no member-of-org-implies-team"
Level: medium
Category: "architecture"
Status: resolved
Package: "organization"
Source: "packages/organization/src/OrganizationRecords.ts:23"
Auditor: "rebac-zanzibar-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RZS-003 — Relationship graph is flat depth-0: no org hierarchy, no team nesting, no member-of-org-implies-team

`MEDIUM` · `architecture` · `organization` · reported by **ReBAC / Zanzibar-style Specialist** (`rebac-zanzibar-specialist`)

Status: **resolved**

## Summary

Neither OrganizationRecord (id/name/slug/logo/metadata/timestamps) nor TeamRecord (TeamRecords.ts:26-33) carries a parent field, and the qadi resolver models no tupleset-to-userset rewrite: the test suite pins that an organization admin is "Unrelated" as team-member (OrganizationQadi.test.ts:136-142), i.e. org-to-team implication is explicitly not derived. In Zanzibar terms the tuple space is two disconnected stars (user#member@org, user#team-member@team, team contained in org as plain data) with no transitive closure, so "member of parent org implies member of child team" — the persona's canonical probe — cannot be expressed without application-side enumeration. Every downstream check is therefore shallow by construction; the moment real hierarchy is needed there is no schema room for it.

## Evidence

Source: `packages/organization/src/OrganizationRecords.ts:23`

```
export interface OrganizationRecord {
  readonly id: string;
  readonly name: string;
```

## Recommended fix

Add optional parent fields (organization.parentId, team hierarchy or team-scoped role inheritance) to the records and derive implied relations in the resolver (org membership grants team-member unless the team is explicitly exclusive), or state the flatness as a scoping decision in the spec and point hierarchical deployments at the ADR-EA-009 delegation path (an external Zanzibar-style engine fed by exported membership tuples).

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Relationship-based authorization
- Full dossier: [`rebac-zanzibar-specialist`](../../.reports/rebac-zanzibar-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`DRS-007` — Organization record has no region/homeRegion attribute — orgs cannot be pinned to a residency zone](medium/DRS-007-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `org-team-hierarchy`. Duplicate of `OHS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/organization/test/OrganizationQadi.test.ts:158`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `OHS-001-organization-hierarchy-specialist` — closed by its fix (see that issue's Resolved comment).
