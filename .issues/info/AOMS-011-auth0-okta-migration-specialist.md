---
ID: "AOMS-011"
Title: "Adoption matrix still claims 'no code exists anywhere' while seven packages are implemented"
Level: info
Category: "docs"
Status: resolved
Package: "—"
Source: "spec/models/00-adoption-matrix.md:17"
Auditor: "auth0-okta-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AOMS-011 — Adoption matrix still claims 'no code exists anywhere' while seven packages are implemented

`INFO` · `docs` · `—` · reported by **Auth0/Okta Migration Specialist** (`auth0-okta-migration-specialist`)

Status: **resolved**

## Summary

Revision 1.1 (2026-09-12) of the matrix asserts the repo is entirely pre-implementation, yet password, oauth, passkey, jwt, organization, and admin are implemented and tested, and roadmap.md revision 1.2 explicitly replaced that same stale line ('Replaced the stale "pre-implementation, no source exists" current-state line — implementation has since progressed through M4 and beyond'). For migration planning this matters beyond pedantry: the matrix is the document a specialist would use to answer 'which methods exist?', and it currently under-reports implemented federation capability (OIDC relying party is live) while correctly reporting SAML/SCIM as unstarted.

## Evidence

Source: `spec/models/00-adoption-matrix.md:17`

```
This document is **not normative**. awthaq is currently **pre-implementation**:
no code exists yet, anywhere in this repository.
```

## Recommended fix

Cut a matrix rev 1.2 mirroring roadmap 1.2's correction: mark Password/OAuth-OIDC/Passkey/JWT/Organization/Admin as implemented, and keep SSO/SAML/OIDC-provider/SCIM as Planned-Phase3.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: IdP Migration Readiness
- Full dossier: [`auth0-okta-migration-specialist`](../../.reports/auth0-okta-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-009` — SAML and SCIM are Phase-3 plans with no code: enterprise IdP interop and directory sync absent](high/AOMS-009-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BDD-005` — Acceptance suite absent for 4 shipped plugins (magic-link, api-key, two-factor, jwt)](medium/BDD-005-bdd-gherkin-acceptance-testing-specialist.md) `_(bdd-gherkin-acceptance-testing-specialist, medium)_`
- [`CWM-002` — SCIM directory sync entirely absent — WorkOS's SCIM wedge has no provisioning surface to migrate onto](high/CWM-002-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `spec-status-banner-sweep`. Evidence at HEAD ec065a7: `spec/models/00-adoption-matrix.md:17`. Fix: Cut adoption-matrix Revision 1.2: add a 'Shipped (unpublished)' status, flip the six implemented rows, rewrite §0/§1/§5 prose, keep the unimplemented rows Planned. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** spec/models/00-adoption-matrix.md rev 1.2: Shipped-Unpublished status added and eight rows flipped (Password, OAuth, Passkey, API Keys, JWT with the Bearer seam, Organization, Admin, SCIM), each naming its package and test directory; Magic Link, Email OTP and Two-Factor stay Planned-Phase2, SSO, OIDC Provider and Device Authorization Planned-Phase3, SAML Scheduled; the preamble, section 1 and section 5 are rewritten. The per-model files 01, 02, 03, 14 and 15 were reconciled in the same pass. Gates: pnpm run typecheck clean, pnpm run spec:verify:strict 28/28, pnpm run check:readmes green.
