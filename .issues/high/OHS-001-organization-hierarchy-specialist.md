---
ID: "OHS-001"
Title: "Team model is flat: no parent pointers, closure structure, or hierarchy queries"
Level: high
Category: "architecture"
Status: resolved
Package: "organization"
Source: "packages/organization/src/TeamRecords.ts:26"
Auditor: "organization-hierarchy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OHS-001 — Team model is flat: no parent pointers, closure structure, or hierarchy queries

`HIGH` · `architecture` · `organization` · reported by **Organization Hierarchy Specialist** (`organization-hierarchy-specialist`)

Status: **resolved**

## Summary

TeamRecord has exactly organizationId + name + memberCount; createTeam (lines 52-55) accepts only {organizationId, name}, and the TeamRecordsShape (lines 51-96) offers no ancestor/descendant, subtree, or move operation. The whole package contains no adjacency list, closure table, materialized path, or recursive CTE — a grep for withTransaction/hierarchy DDL confirms the schema is a single flat table. This is precisely the 'flat org-then-team two-level model' this domain warns about: any application needing nested teams, permission inheritance down a tree, or depth-bounded hierarchy authorization gets nothing. It is a documented spec decision (stories 51-55 scope teams as flat working groups), but the capability gap for the domain is total, and when a parentId is eventually added there is no cycle guard, no move-subtree semantics, and no query pattern to build on.

## Evidence

Source: `packages/organization/src/TeamRecords.ts:26`

```
export interface TeamRecord {
  readonly id: string;
  readonly organizationId: string;
```

## Recommended fix

Decide explicitly: either add real nesting (self-referencing parentId adjacency plus a closure table or recursive CTE in layerSql, with a write-time cycle guard and a moveTeam operation that preserves grants) or state in the README/spec that hierarchy is out of scope so applications do not assume it.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Org hierarchy modeling
- Full dossier: [`organization-hierarchy-specialist`](../../.reports/organization-hierarchy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`OHS-003` — Duplicate team membership corrupts the durable memberCount and capacity caps](high/OHS-003-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, high)_`
- [`OHS-004` — Team membership carries no role; no per-team permission override exists](medium/OHS-004-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, medium)_`
- [`OHS-008` — Count queries load full row sets instead of using COUNT](low/OHS-008-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `TeamRecord` (packages/organization/src/TeamRecords.ts:26-33) has exactly `id`/`name`/`organizationId`/`memberCount`/timestamps, `createTeam` (TeamRecordsShape:52-55) accepts only `{organizationId, name}`, and a repo-wide grep for `parentId|closure|ancestor|hierarchy|subtree|moveTeam` returns zero hits outside this issue file — the model is genuinely flat with no nesting infra anywhere. The auditor's "documented spec decision (stories 51-55)" citation does not resolve: `spec/` has no dedicated organization/team behaviors file, `spec/models/14-organization.md` mentions "team" only once in passing, and no "flat team" scoping decision is discoverable via grep for "flat" across `spec/` or `archive/PRD.md`. The core architecture-gap claim holds; deciding whether to build hierarchy support is a product/design call, not a mechanical fix. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Team hierarchy model (parent pointers / closure structure)](../../.scratch/resolve-ready-for-human-findings/issues/34-team-hierarchy-model.md) — add real nesting: a nullable self-referencing `parentId` on `organization_team` as the write model plus an `organization_team_closure` table as the read model, with new `moveTeam`/`getAncestors`/`getDescendants`/`getSubtree` operations, a write-time cycle guard, and a real migration (the first `Organization` has ever shipped). Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-team-hierarchy`. Evidence at HEAD ec065a7: `packages/organization/src/TeamRecords.ts:26`. Fix: Implement ticket 34: parentId write model + closure-table read model, cycle guard, move/ancestor/descendant/subtree operations, exposed through Organization and its HTTP contract. (effort XL). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`.

**Resolved (2026-09-29):** Team hierarchy shipped (ticket 34, per the plan's recommended option 1: parentId adjacency + closure table). Migration organization_team_hierarchy (parentId column + index, organization_team_closure(ancestorId, descendantId, depth) with a descendant index, self-row backfill for existing teams; proven by a test that migrates a pre-hierarchy schema, inserts a team, then upgrades). TeamRecords (memory derives from parent pointers, SQL reads the closure) gained createTeam(parentId?), moveTeam, getAncestors/getDescendants/getSubtree and errors TeamHierarchyCycle/TeamHasChildren; create/move/remove/removeAll maintain the closure inside sql.withTransaction. Organization/API: createTeam parentId, PATCH teams/:id/parent (team:update; 409 cycle), GET teams/:id/ancestors|descendants (member-only), removeTeam 409 TeamHasChildren (checked before the veto hook, re-checked atomically), TeamDto.parentId, hooks BeforeMoveTeam/AfterMoveTeam, event auth.organization.teamMoved (AuditLog case added). Deviation: no SQL foreign keys (matches every other table here). Permission inheritance is deliberately not part of this (OHS-004). Tests: TeamRecords (both layers + closure row counts + backfill), Organization, AuthHttp; TenantScoping allowlist and AuthComposition manifest updated. tsc/tsconfig.test clean.
