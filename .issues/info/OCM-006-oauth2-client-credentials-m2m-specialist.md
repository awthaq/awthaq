---
ID: "OCM-006"
Title: "JWT mint is exclusively session-bound — no path issues a token to a machine credential"
Level: info
Category: "api"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:127"
Auditor: "oauth2-client-credentials-m2m-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OCM-006 — JWT mint is exclusively session-bound — no path issues a token to a machine credential

`INFO` · `api` · `jwt` · reported by **OAuth2 Client Credentials / M2M Specialist** (`oauth2-client-credentials-m2m-specialist`)

Status: **resolved**

## Summary

The mint endpoint reads CurrentPrincipal, which only the cookie/bearer Authentication middleware provides, so short-lived tokens are minted solely for already-authenticated human sessions — exactly the user-delegated flavor this domain must keep distinct from M2M. Additionally, principalClaims (Jwt.ts:93-102) emits only { sub } for non-User principals: even a hypothetical machine token would carry no scopes or keyId, so downstream stateless authorization would have nothing to check. This is correct today but confirms the missing issuance half of any client-credentials story.

## Evidence

Source: `packages/jwt/src/Jwt.ts:127`

```
mint: Effect.fnUntraced(function* () {
          const principal = yield* Api.CurrentPrincipal;
          const token = yield* jwt.sign(principal).pipe(Effect.orDie);
```

## Recommended fix

When M2M arrives, extend issuance so an authenticated machine principal mints tokens whose claims carry keyId and scopes (via JwtConfig.definePayload or a dedicated claims path), keeping sid/act user-only as the code already does.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: M2M authentication
- Full dossier: [`oauth2-client-credentials-m2m-specialist`](../../.reports/oauth2-client-credentials-m2m-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-012` — Sessions and JWTs carry no authentication-method record (no amr/acr equivalent)](low/AOMS-012-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, low)_`
- [`FAMS-009` — verifyLive scans all of a user's sessions per token check](low/FAMS-009-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- [`JH-008` — Ports-never-provided sandboxing rule is convention, not an enforced boundary](low/JH-008-jared-hanson.md) `_(jared-hanson, low)_`
- [`MAPS-005` — x-jwt-token mirrored onto every authenticated response hands out a portable credential silently](medium/MAPS-005-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`MAPS-006` — verifyLive live-check scans every session of the subject user to find one sid](medium/MAPS-006-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NAM-001` — No stateless JWT session strategy: Jwt plugin still requires the live Sessions store](high/NAM-001-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, high)_`
- [`OCM-007` — No immediate revocation story exists for machine credentials; the only revocation-aware verify is session-scoped](low/OCM-007-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, low)_`
- [`PDR-003` — JWT plugin mirrors a bearer token onto every authenticated response via x-jwt-token with no opt-out](medium/PDR-003-philippe-de-ryck.md) `_(philippe-de-ryck, medium)_`
- … 11 more findings touch `packages/jwt/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `m2m-machine-credentials`. Duplicate of `OCM-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/jwt/src/Jwt.ts:167`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `OCM-001-oauth2-client-credentials-m2m-specialist` — closed by its fix (see that issue's Resolved comment).
