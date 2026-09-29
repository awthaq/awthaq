---
ID: "PDR-003"
Title: "JWT plugin mirrors a bearer token onto every authenticated response via x-jwt-token with no opt-out"
Level: medium
Category: "security"
Status: ready-for-human
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:162"
Auditor: "philippe-de-ryck"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# PDR-003 — JWT plugin mirrors a bearer token onto every authenticated response via x-jwt-token with no opt-out

`MEDIUM` · `security` · `jwt` · reported by **Philippe De Ryck — Web Application Security Trainer** (`philippe-de-ryck`)

Status: **ready-for-human**

## Summary

Installing Jwt overrides PostAuthResponseHook so a freshly signed, sid-bound delegation token is added as a response header on every authenticated response across every installed plugin, 'with no per-plugin opt-in' (the module's own words). A bearer credential valid against any verifyLive-consuming downstream service is therefore routinely present in HTTP responses, where it is readable by any same-origin script (including third-party analytics injected into the host app) and routinely captured by proxies, APM payload logging, and browser devtools exports — my persona's classic 'where can a token accidentally leak beyond the obvious places' answer. The related set-auth-token rotation header (Authentication.ts:223) is scoped more tightly (only on requests that presented a bearer credential), but x-jwt-token fires for plain cookie sessions too.

## Evidence

Source: `packages/jwt/src/Jwt.ts:162`

```
jwt.sign(principal).pipe(
        Effect.map((token) => HttpServerResponse.setHeader(response, "x-jwt-token", token)),
        Effect.catch(() => Effect.succeed(response)),
```

## Recommended fix

Make the mirroring opt-in via JwtConfig (e.g. mirrorOnResponses: false by default), or restrict it to requests that authenticated via bearer; document that response headers are log/proxy capture surface, and consider a SameSite-friendly cookie or a dedicated endpoint as the default delivery.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: Web attack surface
- Full dossier: [`philippe-de-ryck`](../../.reports/philippe-de-ryck/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `jwt-response-mirroring-opt-in`. Evidence at HEAD ec065a7: `packages/jwt/src/Jwt.ts:215`. Fix: Make response mirroring a `JwtConfig` choice (`"off" | "bearer" | "always"`), pass the auth scheme to `PostAuthResponseHook.decorate`, and log rather than silently swallow sign failures. (effort M). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-human.
