---
ID: "AOMS-009"
Title: "SAML and SCIM are Phase-3 plans with no code: enterprise IdP interop and directory sync absent"
Level: high
Category: "architecture"
Status: ready-for-agent
Package: "—"
Source: "spec/models/00-adoption-matrix.md:124"
Auditor: "auth0-okta-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AOMS-009 — SAML and SCIM are Phase-3 plans with no code: enterprise IdP interop and directory sync absent

`HIGH` · `architecture` · `—` · reported by **Auth0/Okta Migration Specialist** (`auth0-okta-migration-specialist`)

Status: **ready-for-agent**

## Summary

The planning docs are honest and specific (10-saml.md sketches the SP plugin including a saml_connection table and an undesigned XML-signature port; 12-scim.md names offboarding as the operative case: without SCIM 'a terminated employee's account [stays] active until someone remembers to remove it by hand'). But nothing exists: no packages/saml, packages/scim, or XML-signature port, and the roadmap deliberately excludes them from v1. For an organization whose Auth0/Okta exit is motivated by enterprise contracts, OIDC-only federation plus manual deprovisioning is usually the disqualifier, and the spec's own priority ordering (SCIM last of all fifteen entries) means the gap persists for the whole visible roadmap.

## Evidence

Source: `spec/models/00-adoption-matrix.md:124`

```
| SAML | Planned-Phase3 | P3 | E2, E5 | [10-saml.md](10-saml.md) |
| OIDC Provider | Planned-Phase3 | P3 | E2, E5 | [11-oidc-provider.md](11-oidc-provider.md) |
| SCIM | Planned-Phase3 | P4 | E5 | [12-scim.md](12-scim.md) |
```

## Recommended fix

Either pull SSO-by-OIDC-federation-per-organization (Auth0 Organizations' core use case) forward using the existing (providerId, subject, issuer) linking plus organization metadata, or publish an explicit 'not an enterprise-IdP replacement yet' position statement so migration planning accounts for it.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: IdP Migration Readiness
- Full dossier: [`auth0-okta-migration-specialist`](../../.reports/auth0-okta-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-011` — Adoption matrix still claims 'no code exists anywhere' while seven packages are implemented](info/AOMS-011-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, info)_`
- [`BDD-005` — Acceptance suite absent for 4 shipped plugins (magic-link, api-key, two-factor, jwt)](medium/BDD-005-bdd-gherkin-acceptance-testing-specialist.md) `_(bdd-gherkin-acceptance-testing-specialist, medium)_`
- [`CWM-002` — SCIM directory sync entirely absent — WorkOS's SCIM wedge has no provisioning surface to migrate onto](high/CWM-002-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `spec/models/00-adoption-matrix.md:124` matches verbatim, and `packages/` has no `saml` or `scim` directory (`ls packages` confirms only the 21 implemented packages, none named saml/scim); SAML/SCIM remain Phase-3/Phase-4 plans only. Whether to pull SSO-by-OIDC forward or publish a "not an enterprise-IdP replacement yet" position is a roadmap/product call, not a mechanical code change. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [SAML/SCIM enterprise IdP interop — roadmap scope decision](../../.scratch/resolve-ready-for-human-findings/issues/08-saml-scim-roadmap-scope.md) — recommend shipping both as new first-party packages (`packages/saml` SP-only, `packages/scim` inbound provisioning), sequenced behind ticket 09's `UserRecord` deactivation state, flagged as a scope call for sanity-check rather than an inevitable conclusion. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `enterprise-federation-saml-scim`. Evidence at HEAD ec065a7: `spec/models/00-adoption-matrix.md:124`. Fix: Execute decision ticket 08's spec half now (ADR + contracts + resequenced roadmap) and its code half in order: UserRecord deactivation (ticket 09) -> packages/scim -> packages/saml (SP-only), SAML runnable in parallel with SCIM substrate. (effort XL). Full dossier: `.plan/slices/12-spec.md`.
