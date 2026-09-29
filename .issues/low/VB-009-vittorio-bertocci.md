---
ID: "VB-009"
Title: "A fresh bearer JWT is mirrored onto every authenticated response"
Level: low
Category: "security"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:162"
Auditor: "vittorio-bertocci"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# VB-009 — A fresh bearer JWT is mirrored onto every authenticated response

`LOW` · `security` · `jwt` · reported by **Vittorio Bertocci — Token-Based Identity Protocol Expert** (`vittorio-bertocci`)

Status: **resolved**

## Summary

Installing Jwt decorates every authenticated response across every plugin with a newly signed 15-minute bearer JWT (better-auth's set-auth-jwt equivalent), with no per-endpoint opt-in and regardless of whether any consumer exists. Each response thus carries a replayable delegation credential through logs, proxies, and CORS-exposed headers, widening the exposure surface of a token nothing in the deployment may consume; signing failures are silently swallowed so the cost is invisible.

## Evidence

Source: `packages/jwt/src/Jwt.ts:162`

```
Effect.map((token) => HttpServerResponse.setHeader(response, "x-jwt-token", token)),
```

## Recommended fix

Make mirroring opt-in (config flag or per-group opt-in), or at minimum restrict it to endpoints that declare a JWT-consuming audience.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: token architecture
- Full dossier: [`vittorio-bertocci`](../../.reports/vittorio-bertocci/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `jwt-response-mirroring-opt-in`. Duplicate of `PDR-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/jwt/src/Jwt.ts:217`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.
