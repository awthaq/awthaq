---
ID: "YL-002"
Title: "No domain/tenant dimension in RBAC; org-scoped power is a parallel relationship mechanism"
Level: medium
Category: "architecture"
Status: resolved
Package: "organization"
Source: "packages/organization/src/OrganizationQadi.ts:16"
Auditor: "yang-luo"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# YL-002 — No domain/tenant dimension in RBAC; org-scoped power is a parallel relationship mechanism

`MEDIUM` · `architecture` · `organization` · reported by **Yang Luo — Creator of Casbin** (`yang-luo`)

Status: **resolved**

## Summary

Casbin makes domain-scoped roles first-class (g, user, role, tenant); here hasRole is tenant-blind because roles are global name->permission sets, and the intended org-scoped attribute route was closed by the engine's own interface: AttributeResolver.resolve takes no resourceId, so 'is this subject an admin of THIS organization' cannot be an attribute check. The plugin rerouted it to RelationshipResolver relations ('admin', 'owner' keyed by resourceId). The result is two different mechanisms for the same concept — a global role set plus relation-based org roles — and a policy author must know which mechanism answers which question; nothing type-level prevents writing hasRole('admin') when the org-scoped relation was meant.

## Evidence

Source: `packages/organization/src/OrganizationQadi.ts:16`

```
// is not expressible through this shape: there is no
// parameter naming which organization is meant. Reading
```

## Recommended fix

Either extend the engine's AttributeResolver (or add a scoped-attribute node) with an optional resourceId so tenant-scoped facts are one mechanism, or document the split loudly: hasRole is global-only, org authority is exclusively hasRelationship('admin'/'owner'), and consider reserving global role names so the two vocabularies cannot collide.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Authorization modeling
- Full dossier: [`yang-luo`](../../.reports/yang-luo/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`OHS-009` — qadi team-member relation is a flat direct lookup; depth and org implication ignored](info/OHS-009-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, info)_`
- [`RRC-003` — qadi authorization decisions read org membership through bare SELECTs with no freshness ordering against membership writes](medium/RRC-003-read-replica-consistency-specialist.md) `_(read-replica-consistency-specialist, medium)_`
- [`RZS-001` — BEH-EA-162's depth-2 resource-to-organization walk is unimplemented; the depth parameter is ignored](high/RZS-001-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, high)_`
- [`RZS-004` — Every relationship check re-reads the source of truth; role relations compute the full permission set they never use](medium/RZS-004-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, medium)_`
- [`RZS-005` — Schema-less hardcoded relation vocabulary conflates RBAC roles with edges and silently answers malformed questions](medium/RZS-005-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, medium)_`
- [`SAM-005` — No RLS-to-qadi translation guidance; the mapping mechanics survive only as inline comments](medium/SAM-005-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `authz-model-boundaries`. Duplicate of `MTI-007` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/organization/src/OrganizationQadi.ts:14`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → resolved.
