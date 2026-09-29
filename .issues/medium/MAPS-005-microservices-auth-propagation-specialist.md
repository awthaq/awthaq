---
ID: "MAPS-005"
Title: "x-jwt-token mirrored onto every authenticated response hands out a portable credential silently"
Level: medium
Category: "security"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:162"
Auditor: "microservices-auth-propagation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MAPS-005 — x-jwt-token mirrored onto every authenticated response hands out a portable credential silently

`MEDIUM` · `security` · `jwt` · reported by **Microservices Auth Propagation Specialist** (`microservices-auth-propagation-specialist`)

Status: **resolved**

## Summary

Installing Jwt overrides the default no-op PostAuthResponseHook so every authenticated response - any plugin, cookie or bearer - carries a freshly minted ~15-minute JWT 'with no per-plugin opt-in' (Jwt.ts:141). This converts a CSRF-protected, rotation-protected, idle-expiring cookie session into a portable bearer token usable at any downstream service that trusts the same JWKS; the cookie's __Host-scoping and SameSite protections do not travel with it. Response headers also routinely land in proxy/access logs. Sign failures are swallowed via Effect.catch (Jwt.ts:163), so delivery is silent best-effort - fine for a bonus header, but it means consumers cannot rely on it either.

## Evidence

Source: `packages/jwt/src/Jwt.ts:162`

```
Effect.map((token) => HttpServerResponse.setHeader(response, "x-jwt-token", token)),
```

## Recommended fix

Gate mirroring behind JwtConfig (default off), and/or stamp mirrored tokens with a distinct downstream audience so they are worthless as edge credentials and useless outside the intended service set.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: Service Boundary Auth Propagation
- Full dossier: [`microservices-auth-propagation-specialist`](../../.reports/microservices-auth-propagation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-012` — Sessions and JWTs carry no authentication-method record (no amr/acr equivalent)](low/AOMS-012-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, low)_`
- [`FAMS-009` — verifyLive scans all of a user's sessions per token check](low/FAMS-009-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- [`JH-008` — Ports-never-provided sandboxing rule is convention, not an enforced boundary](low/JH-008-jared-hanson.md) `_(jared-hanson, low)_`
- [`MAPS-006` — verifyLive live-check scans every session of the subject user to find one sid](medium/MAPS-006-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NAM-001` — No stateless JWT session strategy: Jwt plugin still requires the live Sessions store](high/NAM-001-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, high)_`
- [`OCM-006` — JWT mint is exclusively session-bound — no path issues a token to a machine credential](info/OCM-006-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, info)_`
- [`OCM-007` — No immediate revocation story exists for machine credentials; the only revocation-aware verify is session-scoped](low/OCM-007-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, low)_`
- [`PDR-003` — JWT plugin mirrors a bearer token onto every authenticated response via x-jwt-token with no opt-out](medium/PDR-003-philippe-de-ryck.md) `_(philippe-de-ryck, medium)_`
- … 11 more findings touch `packages/jwt/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `jwt-response-mirroring-opt-in`. Duplicate of `PDR-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/jwt/src/Jwt.ts:217`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.
