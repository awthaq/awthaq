---
ID: "TIR-007"
Title: "Every authenticated response mints a JWT that survives session revocation"
Level: medium
Category: "security"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:160"
Auditor: "token-introspection-revocation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TIR-007 — Every authenticated response mints a JWT that survives session revocation

`MEDIUM` · `security` · `jwt` · reported by **Token Introspection & Revocation Specialist** (`token-introspection-revocation-specialist`)

Status: **resolved**

## Summary

Installing Jwt turns on always-on response mirroring: every authenticated response carries a fresh x-jwt-token. Combined with signature-only verify (no jti, no deny-list, no key-rotation-on-revoke), revoking a session - via /session/revoke, revoke-others, or revoke-all after a password reset - does not invalidate any JWT already minted from it; RFC 7009's cascading-revocation semantics (killing the parent kills derived access tokens) simply do not exist. Mitigated only by the 15-minute default TTL, an attacker holding a mirrored token retains a working credential for up to that window after the compromise is discovered and the session killed, and verifyLive (the intended remedy) is both opt-in and unwired per TIR-001.

## Evidence

Source: `packages/jwt/src/Jwt.ts:160`

```
const decorate: Authentication.PostAuthResponseHookShape["decorate"] = (principal, response) =>
  jwt.sign(principal).pipe(
    Effect.map((token) => HttpServerResponse.setHeader(response, "x-jwt-token", token)),
```

## Recommended fix

Either bound the exposure (shorten default ttl, or document the residual window next to the mirroring hook), or implement cascade: on session revoke, bump a per-session token-version that verifyLive (once wired) checks, and document key rotation as the coarse revocation lever it already is via KeyRing.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Token revocation & introspection
- Full dossier: [`token-introspection-revocation-specialist`](../../.reports/token-introspection-revocation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `jwt-revocation-propagation`. Evidence at HEAD ec065a7: `packages/jwt/src/Jwt.ts:361`. Fix: Finish ticket 11's intent: let `/jwt/introspect` apply the session-liveness check whenever `Sessions` is composed (captured via `Effect.serviceOption`, keeping R = never), and document the bare-`verify` revocation-lag bound. (effort M). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Jwt.make captures Sessions optionally (Effect.serviceOption, R stays never, dependsOn stays empty); new introspectComposed (JwtShape) = introspect + session-liveness check when Sessions was composed, sharing sidStillLiveIn with verifyLive/introspectLive; POST /jwt/introspect now calls it. README/model 08/ADR-EA-017 document that bare verify lags revocation by at most ttl. Tests: packages/jwt/test/JwtIntrospection.test.ts (active:false after revoke when composed; unchanged without Sessions) and AuthHttp.test.ts 'POST /jwt/introspect session liveness (TIR-007)' over real HTTP. SCIM-contract note (SCP-007 step 4) left for when SCIM is specified.
