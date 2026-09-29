---
ID: "RZS-005"
Title: "Schema-less hardcoded relation vocabulary conflates RBAC roles with edges and silently answers malformed questions"
Level: medium
Category: "architecture"
Status: resolved
Package: "organization"
Source: "packages/organization/src/OrganizationQadi.ts:94"
Auditor: "rebac-zanzibar-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RZS-005 — Schema-less hardcoded relation vocabulary conflates RBAC roles with edges and silently answers malformed questions

`MEDIUM` · `architecture` · `organization` · reported by **ReBAC / Zanzibar-style Specialist** (`rebac-zanzibar-specialist`)

Status: **resolved**

## Summary

Relations are a closed four-case switch; there is no namespace config, no relation-schema object, and no application extension point (contrast Roles' configurable catalog at Roles.ts:40-51 and @qadi/core's relationshipResolverFromEdges for static graphs). Two consequences: (1) resource-type mismatches are indistinguishable from honest negatives — hasRelationship("member", teamId) or hasRelationship("team-member", orgId) both fall through to default "Unrelated" (lines 111-112) instead of signaling a malformed question, so an application bug reads as 'not a member'; (2) relation names (admin, owner) are literally membership role strings, entangling the RBAC role namespace with the relationship namespace — a custom dynamic role named "admin" would satisfy the admin relation while carrying none of its statements (see RZS-006).

## Evidence

Source: `packages/organization/src/OrganizationQadi.ts:94`

```
switch (relation) {
            case "member":
              return yield* organization
```

## Recommended fix

Validate that resourceId names the resource type each relation expects (org ids for member/admin/owner, team ids for team-member) and fail malformed pairs with RelationshipResolveError rather than "Unrelated"; expose the relation vocabulary as a configurable map on OrganizationConfig so applications can extend it (e.g. derive relations from dynamic roles) without forking the resolver.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Relationship-based authorization
- Full dossier: [`rebac-zanzibar-specialist`](../../.reports/rebac-zanzibar-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`OHS-009` — qadi team-member relation is a flat direct lookup; depth and org implication ignored](info/OHS-009-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, info)_`
- [`RRC-003` — qadi authorization decisions read org membership through bare SELECTs with no freshness ordering against membership writes](medium/RRC-003-read-replica-consistency-specialist.md) `_(read-replica-consistency-specialist, medium)_`
- [`RZS-001` — BEH-EA-162's depth-2 resource-to-organization walk is unimplemented; the depth parameter is ignored](high/RZS-001-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, high)_`
- [`RZS-004` — Every relationship check re-reads the source of truth; role relations compute the full permission set they never use](medium/RZS-004-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, medium)_`
- [`SAM-005` — No RLS-to-qadi translation guidance; the mapping mechanics survive only as inline comments](medium/SAM-005-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, medium)_`
- [`YL-002` — No domain/tenant dimension in RBAC; org-scoped power is a parallel relationship mechanism](medium/YL-002-yang-luo.md) `_(yang-luo, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-qadi-relationships`. Evidence at HEAD ec065a7: `packages/organization/src/OrganizationQadi.ts:111`. Fix: Fail closed and legibly on malformed relation questions, and stop dynamic/custom role names from shadowing built-ins. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Unrecognised relations, organization-scoped relations naming no organization, and team-member naming no team now answer qadi's 'Unknown' (TeamRecords.findTeamByIdAnyOrg added); OrganizationQadi.test.ts expectation updated. The N8/reserved-name half landed earlier: createRole rejects owner/admin/member and static-custom names (ReservedOrgRoleName 409), Organization.config dies at build on a permissionStatements key that redefines a built-in, PermissionEngine.statementsByRoleFrom is built-in > static > dynamic so a stored dynamic 'owner' row is inert (tests in Organization.test.ts and PermissionEngine.test.ts). Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 896 pass, test:bdd green, spec:verify:strict PASS, oxlint (organization/qadi/roles) clean.
