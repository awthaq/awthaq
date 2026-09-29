---
ID: "MTI-001"
Title: "Tenant scoping is call-site discipline: the records layer is structurally unguarded"
Level: medium
Category: "architecture"
Status: resolved
Package: "organization"
Source: "packages/organization/src/ActiveContextRecords.ts:38"
Auditor: "multi-tenant-isolation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTI-001 — Tenant scoping is call-site discipline: the records layer is structurally unguarded

`MEDIUM` · `architecture` · `organization` · reported by **Multi-Tenant Isolation Specialist** (`multi-tenant-isolation-specialist`)

Status: **resolved**

## Summary

ActiveContextRecords.setOrganization accepts any sessionId and any organizationId, performs no membership validation, and has no error channel — the membership check lives only in Organization.setActive (Organization.ts:1345-1356). The same pattern holds across all six records services: nothing at the data layer requires a tenant predicate, no scoped-repository wrapper exists, the ambient SqlClient is tenant-blind, and a repo-wide search finds zero row-level-security references. The persona's must-have structural technique — making a missing WHERE organizationId structurally impossible — is absent; today's clean record (0 of 21 scoped queries missing the predicate) is enforced by convention and review only. A single new records method, a second caller of setOrganization, or a plugin composing the records layers directly can bypass tenancy with no type or runtime resistance.

## Evidence

Source: `packages/organization/src/ActiveContextRecords.ts:38`

```
sessionId: string,
    organizationId: string | null,
  ) => Effect.Effect<ActiveContextRecord>;
```

## Recommended fix

Make tenant scoping structural: wrap the org-scoped records services in a tenant-bound repository that carries the organizationId in its context (an Effect Layer per request/org) so unscoped queries are unrepresentable, or add a tenant predicate parameter that every SQL builder requires. At minimum, move the membership validation into ActiveContextRecords.setOrganization/setTeam (or make them take the caller principal and fail with MembershipNotFound) so the guard cannot be bypassed by calling the records layer directly.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Multi-Tenant Isolation
- Full dossier: [`multi-tenant-isolation-specialist`](../../.reports/multi-tenant-isolation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`DRS-008` — organization_active_context is keyed by sessionId, coupling core sessions to plugin tables across any future shard boundary](low/DRS-008-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, low)_`
- [`OHS-007` — Deleted teams and organizations leave dangling active-context rows](low/OHS-007-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `org-active-context-lifecycle`. Evidence at HEAD ec065a7: `packages/organization/src/ActiveContextRecords.ts:37`. Fix: Make an unvalidated active-context write unrepresentable at the type level, and pin tenant-predicate discipline in SQL with an architecture test (RLS for plugin tables follows ticket 18). (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** MembershipRecord/TeamMembershipRecord are now Brand.Branded types built through module-private Brand.nominal constructors (no assertions); ActiveContextRecords.setOrganization/setTeam take them as witnesses (unsetOrganization/unsetTeam take the userId), so an unvalidated active-context write does not typecheck (@ts-expect-error test in ActiveContextRecords.test.ts). packages/organization/test/TenantScoping.test.ts reads every src/*Records.ts sql template and fails on an organization_* statement without a tenant key unless it is on the justified allowlist (and on stale allowlist entries). RLS for plugin tables is left to ticket 18 as the dossier says. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 871 pass, test:bdd green, spec:verify:strict PASS, oxlint clean.
