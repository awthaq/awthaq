---
ID: "BDD-005"
Title: "Acceptance suite absent for 4 shipped plugins (magic-link, api-key, two-factor, jwt)"
Level: medium
Category: "testing"
Status: resolved
Package: "—"
Source: "spec/models/00-adoption-matrix.md:118"
Auditor: "bdd-gherkin-acceptance-testing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BDD-005 — Acceptance suite absent for 4 shipped plugins (magic-link, api-key, two-factor, jwt)

`MEDIUM` · `testing` · `—` · reported by **BDD/Gherkin Acceptance Testing Specialist** (`bdd-gherkin-acceptance-testing-specialist`)

Status: **resolved**

## Summary

packages/ ships magic-link, api-key, two-factor, and jwt (plus organization), but spec/behaviors/ has no files for them, so the suite — which by contract only restates the BEH-EA catalog — has zero scenarios for 4 of 7 auth plugins. The adoption matrix marks them Planned-Phase2, yet their implementations already exist, inverting the project's founding discipline that behavior is specified before it is built; there is no acceptance net to catch these plugins drifting, precisely the drift-detection job this suite exists for. Unit tests may partially compensate, but nothing maps their behavior to requirements.

## Evidence

Source: `spec/models/00-adoption-matrix.md:118`

```
| Two-Factor (TOTP) | Planned-Phase2 | P1 | E4 | [06-two-factor-totp.md](06-two-factor-totp.md) |
```

## Recommended fix

Before adding more Phase-2 plugin behavior, author the missing spec/behaviors entries (or an explicit ADR deferring them) and then their .feature restatements; until then, record the four plugins as a known coverage hole in features/README.md's mapping table so the gap is visible rather than implicit.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: BDD acceptance testing
- Full dossier: [`bdd-gherkin-acceptance-testing-specialist`](../../.reports/bdd-gherkin-acceptance-testing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-009` — SAML and SCIM are Phase-3 plans with no code: enterprise IdP interop and directory sync absent](high/AOMS-009-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`AOMS-011` — Adoption matrix still claims 'no code exists anywhere' while seven packages are implemented](info/AOMS-011-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, info)_`
- [`CWM-002` — SCIM directory sync entirely absent — WorkOS's SCIM wedge has no provisioning surface to migrate onto](high/CWM-002-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `bdd-plugin-coverage`. Evidence at HEAD ec065a7: `packages/two-factor/src/index.ts:8`. Fix: Close the real gap — jwt and organization ship without behaviors or acceptance scenarios — by writing their spec/behaviors files and .feature restatements; record magic-link/api-key/two-factor as 'behaviors-before-code' prerequisites of their builds. (effort L). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** P20a: jwt now has spec/behaviors/36-jwt.md (BEH-EA-266..273) and a wired 36-jwt.feature (44 scenarios, all run), organization the same (see MTI-011). magic-link, api-key and two-factor stay behaviors-before-code prerequisites of their builds (P15/P16); no feature files were invented for them.
