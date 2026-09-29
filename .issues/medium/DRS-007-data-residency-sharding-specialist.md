---
ID: "DRS-007"
Title: "Organization record has no region/homeRegion attribute — orgs cannot be pinned to a residency zone"
Level: medium
Category: "compliance"
Status: resolved
Package: "organization"
Source: "packages/organization/src/OrganizationRecords.ts:23"
Auditor: "data-residency-sharding-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DRS-007 — Organization record has no region/homeRegion attribute — orgs cannot be pinned to a residency zone

`MEDIUM` · `compliance` · `organization` · reported by **Data Residency & Sharding Specialist** (`data-residency-sharding-specialist`)

Status: **resolved**

## Summary

The organization entity (:23-30) carries name/slug/logo/metadata only — the one entity whose whole purpose is multi-tenancy has no field expressing where its data must live. The persona's cross-region scenario (members spanning two regions) is also unrepresentable: MembershipRecord (:23-29) links userId to organizationId with no per-membership region override, and organization metadata is an opaque string rather than a typed residency contract. Since organizationId is the only plausible tenant shard key (org tables already carry it; core tables have nothing), the absence of any region binding means there is currently no data-driven way to answer 'which shard does this org belong to'.

## Evidence

Source: `packages/organization/src/OrganizationRecords.ts:23`

```
export interface OrganizationRecord {
  readonly id: string;
  readonly name: string;
```

## Recommended fix

Add a typed residency field (e.g. homeRegion: 'eu' | 'us' | ...) to OrganizationRecord via plugin migration, and define the org-to-shard mapping as a pure function of it; treat member-region overrides as a deliberate, later extension since they force the cross-shard membership design.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: data residency readiness
- Full dossier: [`data-residency-sharding-specialist`](../../.reports/data-residency-sharding-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`RZS-003` — Relationship graph is flat depth-0: no org hierarchy, no team nesting, no member-of-org-implies-team](medium/RZS-003-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-config-and-tenancy`. Evidence at HEAD ec065a7: `packages/organization/src/OrganizationRecords.ts:23`. Fix: Add a typed, config-validated homeRegion to organizations (pending decision) so the org→shard mapping is data-driven. (effort M). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option (config-validated homeRegion) per plan; user may revisit. OrganizationConfig.regions (default empty, so any homeRegion is refused until a deployment lists its vocabulary), organization_org."homeRegion" nullable column (org plugin migration), OrganizationRecord.homeRegion Option, create/update accept it and fail OrganizationApi.UnknownRegion (422), OrganizationDto exposes it, pure Organization.homeRegionOf(record) for shard routing. Tests: OrganizationRecords (memory + SQL, run on Postgres) homeRegion round-trip/clear, Organization.test unknown region rejected on create and update.
