---
ID: "OHS-009"
Title: "qadi team-member relation is a flat direct lookup; depth and org implication ignored"
Level: info
Category: "architecture"
Status: resolved
Package: "organization"
Source: "packages/organization/src/OrganizationQadi.ts:107"
Auditor: "organization-hierarchy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OHS-009 — qadi team-member relation is a flat direct lookup; depth and org implication ignored

`INFO` · `architecture` · `organization` · reported by **Organization Hierarchy Specialist** (`organization-hierarchy-specialist`)

Status: **resolved**

## Summary

The resolver answers team-member from a single direct membership row — no organization-membership implication, no traversal, and the RelationshipCheck's depth parameter is unused, consistent with the flat model. The module header (lines 11-36) honestly documents why the spec's resource-to-org walk and org-scoped attributes are not expressible through the real @qadi/core resolver shapes and were narrowed accordingly, which is good engineering honesty; reviewers should simply know that policies like hasRelationship('member', { depth: 2 }) from the spec's worked examples have no counterpart here — resourceId must name the org/team directly.

## Evidence

Source: `packages/organization/src/OrganizationQadi.ts:107`

```
case "team-member": {
              const membership = yield* teams.findTeamMembership(resourceId, userId);
              return Option.isSome(membership) ? ("Related" as const) : ("Unrelated" as const);
```

## Recommended fix

Keep the narrowed semantics, but document the accepted relation vocabulary and the 'resourceId is the org/team id' contract in the public README so application authors do not copy the spec's depth-2 walk examples.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Org hierarchy modeling
- Full dossier: [`organization-hierarchy-specialist`](../../.reports/organization-hierarchy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`RRC-003` — qadi authorization decisions read org membership through bare SELECTs with no freshness ordering against membership writes](medium/RRC-003-read-replica-consistency-specialist.md) `_(read-replica-consistency-specialist, medium)_`
- [`RZS-001` — BEH-EA-162's depth-2 resource-to-organization walk is unimplemented; the depth parameter is ignored](high/RZS-001-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, high)_`
- [`RZS-004` — Every relationship check re-reads the source of truth; role relations compute the full permission set they never use](medium/RZS-004-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, medium)_`
- [`RZS-005` — Schema-less hardcoded relation vocabulary conflates RBAC roles with edges and silently answers malformed questions](medium/RZS-005-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, medium)_`
- [`SAM-005` — No RLS-to-qadi translation guidance; the mapping mechanics survive only as inline comments](medium/SAM-005-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, medium)_`
- [`YL-002` — No domain/tenant dimension in RBAC; org-scoped power is a parallel relationship mechanism](medium/YL-002-yang-luo.md) `_(yang-luo, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `org-qadi-relationships`. Duplicate of `RZS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/organization/src/OrganizationQadi.ts:107`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `RZS-001-rebac-zanzibar-specialist` — closed by its fix (see that issue's Resolved comment).
