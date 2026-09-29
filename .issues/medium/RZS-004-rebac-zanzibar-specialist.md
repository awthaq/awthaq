---
ID: "RZS-004"
Title: "Every relationship check re-reads the source of truth; role relations compute the full permission set they never use"
Level: medium
Category: "performance"
Status: resolved
Package: "organization"
Source: "packages/organization/src/OrganizationQadi.ts:76"
Auditor: "rebac-zanzibar-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RZS-004 — Every relationship check re-reads the source of truth; role relations compute the full permission set they never use

`MEDIUM` · `performance` · `organization` · reported by **ReBAC / Zanzibar-style Specialist** (`rebac-zanzibar-specialist`)

Status: **resolved**

## Summary

The resolver has no caching, batching, or precomputation of its own — each check costs a findByUserAndOrg round trip, and admin/owner checks go through organization.attributesFor, which (Organization.ts:1931-1944) additionally computes effectivePermissionsOf; with dynamic access control enabled that loads every custom role of the organization via orgRoles.listByOrganization (Organization.ts:970-982) — two sequential lookups and an O(roles) statement merge — only to test membership.value.role.includes(role), a fact already on the membership row. The subject-scoped attributes resolver similarly runs listByUser (all memberships) per attribute resolve. Fine at depth-0 graph sizes; a Zanzibar-grade deployment with hot check paths would see per-check cost grow with each org's role count. The only mitigation available is the caller-provided DecisionCache, whose hazards are covered by RZS-002.

## Evidence

Source: `packages/organization/src/OrganizationQadi.ts:76`

```
const roleRelation = (organizationId: string, userId: Users.UserId, role: string) =>
      organization
        .attributesFor(organizationId, userId)
```

## Recommended fix

Answer member/admin/owner from the membership row directly (findByUserAndOrg alone), reserving attributesFor for callers that need statements; cache statementsByRole per organization with invalidation on role mutations (OrgRoleRecords already has a natural write boundary). If check volume grows, this resolver port is the seam where a precomputed tuple cache would slot in without touching qadi.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Relationship-based authorization
- Full dossier: [`rebac-zanzibar-specialist`](../../.reports/rebac-zanzibar-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`OHS-009` — qadi team-member relation is a flat direct lookup; depth and org implication ignored](info/OHS-009-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, info)_`
- [`RRC-003` — qadi authorization decisions read org membership through bare SELECTs with no freshness ordering against membership writes](medium/RRC-003-read-replica-consistency-specialist.md) `_(read-replica-consistency-specialist, medium)_`
- [`RZS-001` — BEH-EA-162's depth-2 resource-to-organization walk is unimplemented; the depth parameter is ignored](high/RZS-001-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, high)_`
- [`RZS-005` — Schema-less hardcoded relation vocabulary conflates RBAC roles with edges and silently answers malformed questions](medium/RZS-005-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, medium)_`
- [`SAM-005` — No RLS-to-qadi translation guidance; the mapping mechanics survive only as inline comments](medium/SAM-005-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, medium)_`
- [`YL-002` — No domain/tenant dimension in RBAC; org-scoped power is a parallel relationship mechanism](medium/YL-002-yang-luo.md) `_(yang-luo, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-qadi-relationships`. Evidence at HEAD ec065a7: `packages/organization/src/OrganizationQadi.ts:76`. Fix: Answer member and role:* relations from the membership row alone; only permission relations compute statements. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** member and has-role:*/admin/owner relations are one MembershipRecords.findByUserAndOrg lookup (RelationshipResolver now requires MembershipRecords/OrganizationRecords directly); only <resource>:<action> computes statements. Test: OrganizationQadi.test.ts 'member and role relations perform no OrgRoleRecords read' (counting OrgRoleRecords layer with dynamic access control on: 0 reads for member/admin/has-role, >0 for team:create). Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 896 pass, test:bdd green, spec:verify:strict PASS, oxlint (organization/qadi/roles) clean.
