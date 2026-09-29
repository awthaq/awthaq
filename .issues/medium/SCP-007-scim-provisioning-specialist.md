---
ID: "SCP-007"
Title: "Deprovisioning propagation depends on opt-in verifyLive: plain verify keeps accepting revoked-session JWTs until exp"
Level: medium
Category: "security"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:68"
Auditor: "scim-provisioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SCP-007 — Deprovisioning propagation depends on opt-in verifyLive: plain verify keeps accepting revoked-session JWTs until exp

`MEDIUM` · `security` · `jwt` · reported by **SCIM Provisioning Specialist** (`scim-provisioning-specialist`)

Status: **resolved**

## Summary

The good news: Sessions.revokeAll exists and jwt's verifyLive (ticket 12) re-checks the sid against the live session store, so a SCIM deactivate handler calling revokeAll genuinely kills both sessions and verifyLive-checked tokens immediately. The gap: verifyLive is opt-in and plain verify is the documented default that honors a revoked session's JWT until its own exp — so offboarding propagation speed for token-bearing clients depends entirely on which verify each endpoint chose, with no repo-level guarantee. The spec's own open question ('no answer to how a SCIM-deactivated user interacts with already-issued sessions', spec/models/12-scim.md:57) is therefore half-answered by primitives but unwired into a contract.

## Evidence

Source: `packages/jwt/src/Jwt.ts:68`

```
The documented, deliberate weakening `verify` alone carries (a revoked session's JWT keeps verifying until its own `exp`) does not apply here.
```

## Recommended fix

When specifying SCIM, make the deactivation contract explicit: deactivate => Sessions.revokeAll + required verifyLive on any JWT-verifying endpoint (or a short max token TTL with sid anchoring), and document that plain verify is only acceptable for non-security-sensitive reads.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: SCIM provisioning
- Full dossier: [`scim-provisioning-specialist`](../../.reports/scim-provisioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-012` — Sessions and JWTs carry no authentication-method record (no amr/acr equivalent)](low/AOMS-012-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, low)_`
- [`FAMS-009` — verifyLive scans all of a user's sessions per token check](low/FAMS-009-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- [`JH-008` — Ports-never-provided sandboxing rule is convention, not an enforced boundary](low/JH-008-jared-hanson.md) `_(jared-hanson, low)_`
- [`MAPS-005` — x-jwt-token mirrored onto every authenticated response hands out a portable credential silently](medium/MAPS-005-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`MAPS-006` — verifyLive live-check scans every session of the subject user to find one sid](medium/MAPS-006-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NAM-001` — No stateless JWT session strategy: Jwt plugin still requires the live Sessions store](high/NAM-001-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, high)_`
- [`OCM-006` — JWT mint is exclusively session-bound — no path issues a token to a machine credential](info/OCM-006-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, info)_`
- [`OCM-007` — No immediate revocation story exists for machine credentials; the only revocation-aware verify is session-scoped](low/OCM-007-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, low)_`
- … 11 more findings touch `packages/jwt/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence medium); workstream `jwt-revocation-propagation`. Duplicate of `TIR-007` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/jwt/src/Jwt.ts:443`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.
