---
ID: "AOMS-012"
Title: "Sessions and JWTs carry no authentication-method record (no amr/acr equivalent)"
Level: low
Category: "api"
Status: ready-for-agent
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:96"
Auditor: "auth0-okta-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AOMS-012 — Sessions and JWTs carry no authentication-method record (no amr/acr equivalent)

`LOW` · `api` · `jwt` · reported by **Auth0/Okta Migration Specialist** (`auth0-okta-migration-specialist`)

Status: **ready-for-agent**

## Summary

principalClaims emits only sub/sid/act and SessionView records no authentication strategy, so downstream systems cannot tell a password login from an Okta-federated one, and no LoA/acr claim exists for policy engines that gated on Auth0's amr values. During a coexistence period this is what lets an application treat the two identity sources differently (e.g. require re-verification for password logins but trust federated ones); without it, the phased rollout's risk asymmetries are invisible at the token layer. The signedIn event does carry strategy (packages/core/src/AuthEvents.ts:35-39) but only into an in-memory PubSub.

## Evidence

Source: `packages/jwt/src/Jwt.ts:96`

```
        sub: principal.ref.id,
        sid: principal.sessionId,
        ...(principal.actingAs !== undefined
```

## Recommended fix

Add an amr-style claim path: issue() and the OAuth callback record the strategy on the session (a column), and principalClaims copies it into the JWT; keep definePayload for app-defined extras so this stays a core concern, not per-app code.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: IdP Migration Readiness
- Full dossier: [`auth0-okta-migration-specialist`](../../.reports/auth0-okta-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`FAMS-009` — verifyLive scans all of a user's sessions per token check](low/FAMS-009-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- [`JH-008` — Ports-never-provided sandboxing rule is convention, not an enforced boundary](low/JH-008-jared-hanson.md) `_(jared-hanson, low)_`
- [`MAPS-005` — x-jwt-token mirrored onto every authenticated response hands out a portable credential silently](medium/MAPS-005-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`MAPS-006` — verifyLive live-check scans every session of the subject user to find one sid](medium/MAPS-006-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NAM-001` — No stateless JWT session strategy: Jwt plugin still requires the live Sessions store](high/NAM-001-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, high)_`
- [`OCM-006` — JWT mint is exclusively session-bound — no path issues a token to a machine credential](info/OCM-006-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, info)_`
- [`OCM-007` — No immediate revocation story exists for machine credentials; the only revocation-aware verify is session-scoped](low/OCM-007-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, low)_`
- [`PDR-003` — JWT plugin mirrors a bearer token onto every authenticated response via x-jwt-token with no opt-out](medium/PDR-003-philippe-de-ryck.md) `_(philippe-de-ryck, medium)_`
- … 11 more findings touch `packages/jwt/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-authentication-methods`. Evidence at HEAD ec065a7: `packages/jwt/src/Jwt.ts:133`. Fix: Record RFC 8176-style authentication methods on the session, carry them on the UserPrincipal, and emit `amr` + `auth_time` in principal JWTs. (effort L). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.
