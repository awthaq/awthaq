---
ID: "OHS-004"
Title: "Team membership carries no role; no per-team permission override exists"
Level: medium
Category: "architecture"
Status: ready-for-human
Package: "organization"
Source: "packages/organization/src/TeamRecords.ts:35"
Auditor: "organization-hierarchy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OHS-004 — Team membership carries no role; no per-team permission override exists

`MEDIUM` · `architecture` · `organization` · reported by **Organization Hierarchy Specialist** (`organization-hierarchy-specialist`)

Status: **ready-for-human**

## Summary

TeamMembershipRecord is bare id/teamId/userId/createdAt — there is no team-level role, and all team mutations are gated by org-level ('team', 'update'/'delete') statements (Organization.ts:1869, 1837, 1897). The only inheritance rule in the package is therefore 'org owner/admin controls every team identically' — exactly the 'child inherits everything from parent' shape this domain flags, with no override semantics anywhere: a team lead cannot be modeled, and a lead's authority cannot be scoped to one team. The spec's 'team-member' qadi relation (story 55) distinguishes membership, not authority.

## Evidence

Source: `packages/organization/src/TeamRecords.ts:35`

```
export interface TeamMembershipRecord {
  readonly id: string;
  readonly teamId: string;
  readonly userId: Users.UserId;
```

## Recommended fix

Add a role column to organization_team_membership plus team-scoped statements (or a team-lead role resolution rule) with explicit precedence: org-level team statements as the inherited default, per-team role as the overridable refinement.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Org hierarchy modeling
- Full dossier: [`organization-hierarchy-specialist`](../../.reports/organization-hierarchy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`OHS-001` — Team model is flat: no parent pointers, closure structure, or hierarchy queries](high/OHS-001-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, high)_`
- [`OHS-003` — Duplicate team membership corrupts the durable memberCount and capacity caps](high/OHS-003-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, high)_`
- [`OHS-008` — Count queries load full row sets instead of using COUNT](low/OHS-008-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-team-hierarchy`. Evidence at HEAD ec065a7: `packages/organization/src/TeamRecords.ts:35`. Fix: Add team-scoped roles with explicit precedence (pending decision; ticket 34 deferred inheritance here). (effort L). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-human.
