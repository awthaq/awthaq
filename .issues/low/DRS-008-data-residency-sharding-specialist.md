---
ID: "DRS-008"
Title: "organization_active_context is keyed by sessionId, coupling core sessions to plugin tables across any future shard boundary"
Level: low
Category: "architecture"
Status: resolved
Package: "organization"
Source: "packages/organization/src/ActiveContextRecords.ts:3"
Auditor: "data-residency-sharding-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DRS-008 — organization_active_context is keyed by sessionId, coupling core sessions to plugin tables across any future shard boundary

`LOW` · `architecture` · `organization` · reported by **Data Residency & Sharding Specialist** (`data-residency-sharding-specialist`)

Status: **resolved**

## Summary

The active-org/team state row is keyed by sessionId (:3-5) rather than userId, so it is a cross-domain join between core session rows and org-plugin rows. That is harmless today, but it is the only plugin table keyed on a core-side key, and it hard-binds org data to the session shard: if sessions shard by user-region while organizations shard by org home region (DRS-001/DRS-007), every sign-in's context read becomes a cross-shard join on the hot path. It also inherits the erasure gap in DRS-002 — deleting a user's sessions orphans these rows forever.

## Evidence

Source: `packages/organization/src/ActiveContextRecords.ts:3`

```
// spec.md's "Active organization/team state": persistence for
// `organization_active_context`, a plugin-owned table keyed by `sessionId`
```

## Recommended fix

Either re-key by userId (matching the delete cascade that exists) or document sessionId-keying as a deliberate trade; in either case, classify this table's shard placement in the residency ADR so the sign-in read path stays single-shard.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: data residency readiness
- Full dossier: [`data-residency-sharding-specialist`](../../.reports/data-residency-sharding-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`MTI-001` — Tenant scoping is call-site discipline: the records layer is structurally unguarded](medium/MTI-001-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`
- [`OHS-007` — Deleted teams and organizations leave dangling active-context rows](low/OHS-007-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-active-context-lifecycle`. Evidence at HEAD ec065a7: `packages/organization/src/ActiveContextRecords.ts:3`. Fix: Keep sessionId as the key (active org is per-session by design) but add an indexed userId column so the row can be cleared on user erasure and membership removal, and document its shard placement. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** organization_active_context gains a nullable userId column + index (migration organization_active_context_user_id); ActiveContextRecord.userId (Option); records ops unsetOrganization/unsetTeam/clearOrganization/clearOrganizationForUser/clearTeam/deleteAllByUser on both layers; Organization.beforeUserDeleteErasure now also sweeps the user's active-context rows (RIn gains ActiveContextRecords); ActiveContextRecords.ts header rewritten (sessionId key is deliberate, userId is the erasure/revocation index, shard placement). Tests: ActiveContextRecords.test.ts (both layers) deleteAllByUser + clear ops, OrganizationErasure.test.ts sweep (red before). Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 871 pass, test:bdd green, spec:verify:strict PASS, oxlint clean.
