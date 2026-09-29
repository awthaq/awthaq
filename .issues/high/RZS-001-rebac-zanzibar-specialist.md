---
ID: "RZS-001"
Title: "BEH-EA-162's depth-2 resource-to-organization walk is unimplemented; the depth parameter is ignored"
Level: high
Category: "correctness"
Status: resolved
Package: "organization"
Source: "packages/organization/src/OrganizationQadi.ts:89"
Auditor: "rebac-zanzibar-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RZS-001 — BEH-EA-162's depth-2 resource-to-organization walk is unimplemented; the depth parameter is ignored

`HIGH` · `correctness` · `organization` · reported by **ReBAC / Zanzibar-style Specialist** (`rebac-zanzibar-specialist`)

Status: **resolved**

## Summary

spec/behaviors/21-qadi-resolvers-obligations.md (BEH-EA-162) and BDD scenario REQ-EA-454 (features/features/06-roles-and-authorization-bridge/21-qadi-resolvers-obligations.feature:43-48) require that a "member" relation be resolved "by walking from the resource to its owning organization and checking membership there" at depth 2 ("member of a project = member of the project's organization"). The implementation destructures only subjectId/relation/resourceId — the RelationshipCheck.depth field is never read — and every relation is a single direct row lookup where resourceId must already BE the org or team id. A policy asking hasRelationship at depth > 0 for any non-org resource silently gets "Unrelated" (deny), with no error and no recorded deviation. This is a MUST-level spec requirement the shipped code does not meet, discoverable only by reading both files side by side.

## Evidence

Source: `packages/organization/src/OrganizationQadi.ts:89`

```
check: ({ subjectId, relation, resourceId }) =>
```

## Recommended fix

Either implement the walk — resolve the checked resource to its owning organization (a resource-to-owner relation table or convention) and then check membership — or record the deferral explicitly in OrganizationQadi.ts's header comment (the codebase's established honest-deferral pattern) and mark REQ-EA-454 unimplemented in features/traceability.md so applications do not rely on depth semantics that do not exist.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Relationship-based authorization
- Full dossier: [`rebac-zanzibar-specialist`](../../.reports/rebac-zanzibar-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`OHS-009` — qadi team-member relation is a flat direct lookup; depth and org implication ignored](info/OHS-009-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, info)_`
- [`RRC-003` — qadi authorization decisions read org membership through bare SELECTs with no freshness ordering against membership writes](medium/RRC-003-read-replica-consistency-specialist.md) `_(read-replica-consistency-specialist, medium)_`
- [`RZS-004` — Every relationship check re-reads the source of truth; role relations compute the full permission set they never use](medium/RZS-004-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, medium)_`
- [`RZS-005` — Schema-less hardcoded relation vocabulary conflates RBAC roles with edges and silently answers malformed questions](medium/RZS-005-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, medium)_`
- [`SAM-005` — No RLS-to-qadi translation guidance; the mapping mechanics survive only as inline comments](medium/SAM-005-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, medium)_`
- [`YL-002` — No domain/tenant dimension in RBAC; org-scoped power is a parallel relationship mechanism](medium/YL-002-yang-luo.md) `_(yang-luo, medium)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — OrganizationQadi.ts:89's `check` destructures only `{subjectId, relation, resourceId}`; `depth` is never read, and every relation case (lines 94-113) requires `resourceId` to already be the org/team id, defaulting non-matching resources to `"Unrelated"` rather than `RelationshipResolveError`, contra BEH-EA-162's MUST-level requirement (spec/behaviors/21-qadi-resolvers-obligations.md:60-63) and `@qadi/core`'s `RelationshipCheck.depth` field. features/traceability.md:474-475 lists REQ-EA-454/455 without marking them unimplemented. Whether/how to implement a generic resource-to-org walk is a genuine design decision. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [ReBAC depth-N resource-to-organization walk](../../.scratch/resolve-ready-for-human-findings/issues/13-rebac-depth-n-resource-walk.md) — Resolved via a new required `ResourceOrganizationLookup` port (app-provided, with a `layerNone` default) that `OrganizationQadi.relationships` consults when `depth >= 1`; a missing/unresolved lookup now fails closed with `RelationshipResolveError`, never silently returns `"Unrelated"`. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-qadi-relationships`. Evidence at HEAD ec065a7: `packages/organization/src/OrganizationQadi.ts:89`. Fix: Implement the ticket-13 decision: a required, app-provided ResourceOrganizationLookup port consulted for member at depth >= 1; unresolved fails closed with RelationshipResolveError. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`.

**Resolved (2026-09-29):** OrganizationQadi.ts: new ResourceOrganizationLookup Context.Service (organizationOf: resourceId -> Effect<Option<orgId>, unknown>) with static layerNone; relationships requires it and check now reads depth: member at depth >= 1 asks the lookup, None or a lookup failure -> RelationshipResolveError (never Unrelated), depth undefined/0 unchanged; only member walks (ticket 13 scope). Header comment and BEH-EA-162 prose rewritten. Tests: OrganizationQadi.test.ts 'member at depth >= 1 (RZS-001)' x3 (Related through the app lookup, Unknown at depth 0 for a project id, orphan/failing lookup and layerNone -> RelationshipResolveError). Deferred: BDD wiring of REQ-EA-454/455 (the feature file is @skip @unwired at Feature level; not cheap). Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 896 pass, test:bdd green, spec:verify:strict PASS, oxlint (organization/qadi/roles) clean.
