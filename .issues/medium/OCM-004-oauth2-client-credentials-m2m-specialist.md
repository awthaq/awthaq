---
ID: "OCM-004"
Title: "M2M BDD acceptance (REQ-EA-199) has no step definitions — the machine path is unexecuted prose"
Level: medium
Category: "testing"
Status: ready-for-agent
Package: "—"
Source: "features/features/03-http-layer/09-authentication-middleware.feature:136"
Auditor: "oauth2-client-credentials-m2m-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OCM-004 — M2M BDD acceptance (REQ-EA-199) has no step definitions — the machine path is unexecuted prose

`MEDIUM` · `testing` · `—` · reported by **OAuth2 Client Credentials / M2M Specialist** (`oauth2-client-credentials-m2m-specialist`)

Status: **ready-for-agent**

## Summary

The feature file defines the M2M acceptance scenarios (REQ-EA-199, REQ-EA-201), but features/step-definitions/ contains only Admin, Password, OAuth, Passkey, Session, and Smoke step files — nothing covers 09-authentication-middleware.feature, so its scenarios cannot run. Traceability (traceability.md REQ-EA-199) presents the mapping as if covered; in reality the referenced ApiKeyAuthentication middleware exists nowhere in code (Api.ts declares only Authentication, OptionalAuthentication, CsrfProtection) and the server strategy chain is { cookie, bearer } (server/src/Authentication.ts:283).

## Evidence

Source: `features/features/03-http-layer/09-authentication-middleware.feature:136`

```
Scenario: A machine-to-machine group under ApiKeyAuthentication resolves a ServicePrincipal
  Given a group "machine" carrying "ApiKeyAuthentication"
  When a request presents a valid "x-api-key" header to the "machine" group
```

## Recommended fix

When M7 lands, add AuthenticationSteps.ts covering REQ-EA-197 through REQ-EA-203 including the x-api-key-to-ServicePrincipal scenario; until then, keep the roadmap's honest 'Not yet active' framing visible next to the traceability rows so the dashboard does not read REQ-EA-199 as verified.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: M2M authentication
- Full dossier: [`oauth2-client-credentials-m2m-specialist`](../../.reports/oauth2-client-credentials-m2m-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `bdd-feature-wiring`. Evidence at HEAD ec065a7: `features/features/03-http-layer/09-authentication-middleware.feature:136`. Fix: Wire 09-authentication-middleware.feature as AH-003 Tier 1 now (all Rules except the ApiKey scenarios), keep REQ-EA-199/201 explicitly @skip'd as 'blocked by api-key plugin (OCM-001)', and wire them when packages/api-key ships ApiKeyAuthentication. (effort M). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
