---
ID: "CWM-002"
Title: "SCIM directory sync entirely absent — WorkOS's SCIM wedge has no provisioning surface to migrate onto"
Level: high
Category: "architecture"
Status: ready-for-agent
Package: "—"
Source: "spec/models/00-adoption-matrix.md:126"
Auditor: "clerk-workos-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CWM-002 — SCIM directory sync entirely absent — WorkOS's SCIM wedge has no provisioning surface to migrate onto

`HIGH` · `architecture` · `—` · reported by **Clerk/WorkOS Migration Specialist** (`clerk-workos-migration-specialist`)

Status: **ready-for-agent**

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
