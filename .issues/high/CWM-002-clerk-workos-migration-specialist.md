---
ID: "CWM-002"
Title: "SCIM directory sync entirely absent — WorkOS's SCIM wedge has no provisioning surface to migrate onto"
Level: high
Category: "architecture"
Status: resolved
Package: "—"
Source: "spec/models/00-adoption-matrix.md:126"
Auditor: "clerk-workos-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CWM-002 — SCIM directory sync entirely absent — WorkOS's SCIM wedge has no provisioning surface to migrate onto

`HIGH` · `architecture` · `—` · reported by **Clerk/WorkOS Migration Specialist** (`clerk-workos-migration-specialist`)

Status: **resolved**

## Summary

Grep for scim/directory-sync across packages/ returns zero source matches; the domain exists only as planning artifacts, classified Planned-Phase3 priority P4 — the least-designed enterprise row. For a Clerk/WorkOS migration specialist this is the decisive gap on the WorkOS side: enterprise buyers provision and deprovision via directory sync, and neither the inbound SCIM endpoints, an external-id mapping on User, nor a deactivation-not-delete lifecycle exists (Users has only a destructive delete). The absence is honestly governed and deliberately phased — the roadmap explicitly puts SSO/SCIM behind waves 1-2 — and the substrate it will need is partially in place (Sessions.revokeAll for immediate invalidation, organization membership rows as the Group mapping target, api-key as the eventual bearer-credential home). But until it lands, migrating any app whose enterprise contracts include directory sync is not possible, and the persona's red flag — orphaned active sessions for directory-removed users — has no automated defense beyond application code.

## Evidence

Source: `spec/models/00-adoption-matrix.md:126`

```
| SCIM | Planned-Phase3 | P4 | E5 | [12-scim.md](12-scim.md) |
```

## Recommended fix

Keep the phasing, but sequence the substrate now: add a suspendable user state (active/suspended) and an external-id/tombstone table so SCIM active:false is representable; publish the SCIM server contract (schema, connection bearer auth, idempotent PATCH) as spec work before Phase 3 begins; document the interim recipe (subscribe to auth.organization.memberRemoved + Sessions.revokeAll) so self-migrating teams are not left to invent deprovisioning.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Clerk/WorkOS migration parity
- Full dossier: [`clerk-workos-migration-specialist`](../../.reports/clerk-workos-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-009` — SAML and SCIM are Phase-3 plans with no code: enterprise IdP interop and directory sync absent](high/AOMS-009-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`AOMS-011` — Adoption matrix still claims 'no code exists anywhere' while seven packages are implemented](info/AOMS-011-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, info)_`
- [`BDD-005` — Acceptance suite absent for 4 shipped plugins (magic-link, api-key, two-factor, jwt)](medium/BDD-005-bdd-gherkin-acceptance-testing-specialist.md) `_(bdd-gherkin-acceptance-testing-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `spec/models/00-adoption-matrix.md:126` matches the quoted `| SCIM | Planned-Phase3 | P4 | E5 |...` row exactly, and a repo-wide grep for `scim`/`directory-sync` in `packages/*/src` returns zero matches. `packages/core/src/Users.ts` exposes only a destructive `delete` (line 67/173/282), no suspend/active state. Whether to pull SCIM substrate work forward is a roadmap/product decision. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [SAML/SCIM enterprise IdP interop — roadmap scope decision](../../.scratch/resolve-ready-for-human-findings/issues/08-saml-scim-roadmap-scope.md) — recommend shipping `packages/scim` as a first-party package sequenced behind ticket 09's `UserRecord` deactivation state and a new external-id mapping table, wired to the existing `Sessions.revokeAll`; flagged as a scope call for sanity-check. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `enterprise-federation-saml-scim`. Evidence at HEAD ec065a7: `spec/models/00-adoption-matrix.md:126`. Fix: Per decision 08: after ticket 09's UserRecord deactivation state lands, ship `packages/scim` (inbound RFC 7644) with an external-id mapping table and Sessions.revokeAll on deactivation; publish the interim deprovisioning recipe now. (effort XL). Full dossier: `.plan/slices/12-spec.md`.

**Resolved (2026-09-29):** SCIM implemented as the new package @awthaq/scim (ADR-EA-023, BEH-EA-246..253 - NOTE for the orchestrator: ADR-EA-023 (the plan proposed 019, taken by encryption-key-rotation) and BEH-EA-238..253 / migration-free ids may collide; renumber at integration). Substrate used, not re-decided: Users.setStatus/assertCanSignIn (P14) and Sessions.revokeAll. Scim plugin (id scim, dependsOn [Organization]): tables scim_connection (SHA-256 token hash, revocable) and scim_resource (per-connection ownership and external-id map; named scim_resource not scim_external_id because externalId is optional and groups map too); ScimConnectionStore (token shown once, scim_ + 256 random bits) and ScimAuthenticationLive (bearer, constant-time hash compare, uniform 401 for unknown/revoked/suspended-organization); /scim/v2 Users (list with userName/externalId eq filters and startIndex/count, POST idempotent on externalId, GET, PUT, PATCH with Okta path-less and Entra capitalised/string-boolean forms, DELETE deactivate by default or erase by config), Groups as organization teams (only provisioned users, only groups the connection created), ServiceProviderConfig/ResourceTypes/Schemas, RFC 7644 error bodies, application/scim+json in and out. Safety rules beyond the dossier, recorded in the ADR and BEH: a connection acts only on what it provisioned and never adopts an existing account by email (409 uniqueness), userName is immutable (400 mutability), active:true lifts only a suspension the same connection made (statusReason scim:<connectionId>) so an admin ban stays, group member replacement never touches unprovisioned team members. Events auth.scim.userProvisioned/userDeactivated/userReactivated/userDeleted/groupChanged (AuthEvents + AuditLog mapping). The interim deprovisioning recipe is in spec/models/12-scim.md, packages/organization/README.md and packages/scim/README.md. Tests (52): domain suites for users, groups and records (memory, SQL, Postgres via test:pg) and real-HTTP suites for auth, content types, error and discovery shapes. Not built: /Bulk, sortBy, /Me, ETag, compound filters, HTTP CRUD for connections; group changes bypass the organization team hooks (they publish auth.scim.groupChanged).
