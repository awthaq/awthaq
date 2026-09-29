---
ID: "EP-001"
Title: "No tenant model exists; one static composition per process is the only deployment shape"
Level: high
Category: "architecture"
Status: resolved
Package: "—"
Source: "spec/decisions/005-static-composition.md:23"
Auditor: "eugenio-pace"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# EP-001 — No tenant model exists; one static composition per process is the only deployment shape

`HIGH` · `architecture` · `—` · reported by **Co-founder/former CEO of Auth0** (`eugenio-pace`)

Status: **resolved**

## Summary

The entire platform is single-tenant by construction: one `Auth.make([...])` tuple per process (examples/memory-server/index.ts:40), no tenant identifier in any SQL model (grep for tenantId/organization_id in packages/sql/src returns nothing), and the codebase's own isolation commentary treats a second composition in-process as a test hazard, not a tenancy unit (packages/core/src/RateLimits.ts:15-16: 'two tenants, polluting each other's rule list'). An Auth0-style tenant model — tenant-scoped config, data, and connections behind one deployment — has no anchor here. This is a deliberate library-vs-platform stance, but it is the single largest gap between this codebase and IDaaS readiness.

## Evidence

Source: `spec/decisions/005-static-composition.md:23`

```
The plugin set passed to `Auth.make` is fixed at composition time and is not runtime-reconfigurable
```

## Recommended fix

Decide and document the tenancy boundary explicitly: either (a) tenant = organization row, add an organizationId scoping story to the SQL repositories and a tenant-resolution middleware in @awthaq/server, or (b) declare host-per-tenant deployments (one composition per tenant) as the supported model and provide the operational tooling (per-tenant composition roots, config) that makes it real. Do not leave it implicit.

## Context

- Auditor verdict on this domain: **needs-work** (score 48/100), domain: multi-tenant SaaS readiness
- Full dossier: [`eugenio-pace`](../../.reports/eugenio-pace/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`EP-007` — Per-tenant configuration mechanism designed but unimplemented](medium/EP-007-eugenio-pace.md) `_(eugenio-pace, medium)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — evidence quote matches `spec/decisions/005-static-composition.md:23` exactly; `grep -rn "tenantId\|organization_id\|organizationId" packages/sql/src` returns nothing, and the ADR itself (line 39) says "Not yet implemented — see spec/roadmap.md for milestone." The gap is real, but choosing between org-scoped SQL tenancy vs. host-per-tenant deployment is a product/architecture decision, not a mechanical patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Multi-tenant composition model, per-org OAuth connections & tenant/shard key schema](../../.scratch/resolve-ready-for-human-findings/issues/18-multi-tenant-composition-oauth-connections.md) — Resolved: tenant = an `Organization` row, per `ADR-EA-005`'s own already-written `Context.Reference`/`LayerMap.Service` prescription for per-tenant resources — not a new plugin or a host-per-tenant deployment shape. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `multi-tenant-composition`. Evidence at HEAD ec065a7: `spec/decisions/005-static-composition.md:23`. Fix: Implement decision ticket 18: tenant = Organization row; ambient `TenantContext` in core; nullable indexed `tenant_id` on the five core tables stamped on every write; `TenantResolver` port + opt-in `Organization.tenantMiddleware`; Postgres RLS; per-org OAuth connections via a LayerMap-backed `OrganizationConnections`. Record it as an ADR first. (effort XL). Full dossier: `.plan/slices/12-spec.md`.

**Resolved (2026-09-29):** Decision ticket 18 implemented across DRS-001 (tenant column, ambient TenantContext, stamping, opt-in Postgres RLS), EP-004 (per-organization connections) and this issue: ADR-EA-018 recorded (spec/decisions/018-tenancy-is-an-organization.md, index.yaml, ADR-005 now points at it), TenantResolver port and Organization.tenantMiddleware / tenantMiddlewareWithRls (BEH-EA-229; an id naming no organization is 404, never untenanted; tests over a real Node server), spec/models/14-organization.md Tenancy section. Deviation from the dossier, per the adopted DRS-005 option A: finders do NOT filter users/accounts by tenant (the identity directory is global, one person in many organizations), so the dossier test findByEmail-does-not-see-another-tenants-user is replaced by its opposite; isolation is attribution on every row plus RLS on the partitioned tables. Not done: the @skip-until-wired BDD scenario two tenants may register the same email is dropped (contradicts option A); examples/memory-server two-tenant demo not added.
