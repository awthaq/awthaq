---
ID: "OCM-007"
Title: "No immediate revocation story exists for machine credentials; the only revocation-aware verify is session-scoped"
Level: low
Category: "security"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:69"
Auditor: "oauth2-client-credentials-m2m-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OCM-007 — No immediate revocation story exists for machine credentials; the only revocation-aware verify is session-scoped

`LOW` · `security` · `jwt` · reported by **OAuth2 Client Credentials / M2M Specialist** (`oauth2-client-credentials-m2m-specialist`)

Status: **resolved**

## Summary

The interview question 'revoke a compromised M2M client immediately versus waiting for token expiry' has no answer in code: no API key exists to revoke, and the one revocation-aware verification path (verifyLive) routes through user Sessions, which a machine credential has no row in. Plain verify is stateless with the documented weakening (a revoked subject's token verifies until its own exp). For high-throughput service callers, stateless validation with fast revocation must be designed, not assumed.

## Evidence

Source: `packages/jwt/src/Jwt.ts:69`

```
readonly verifyLive: (
    token: string,
  ) => Effect.Effect<Record<string, unknown>, JwtCodec.JwtInvalidError, Sessions.Sessions>;
```

## Recommended fix

Implement api-key revoke as an immediate store write on the key row (delete or revokedAt), and for JWT-flavored machine tokens add a short-TTL negative cache of revoked keyIds checked only on verify, bounding staleness (e.g. seconds) while keeping the hot path stateless.

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
- [`OCM-006` — JWT mint is exclusively session-bound — no path issues a token to a machine credential](info/OCM-006-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, info)_`
- [`PDR-003` — JWT plugin mirrors a bearer token onto every authenticated response via x-jwt-token with no opt-out](medium/PDR-003-philippe-de-ryck.md) `_(philippe-de-ryck, medium)_`
- … 11 more findings touch `packages/jwt/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `m2m-machine-credentials`. Duplicate of `OCM-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/jwt/src/Jwt.ts:472`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `OCM-002-oauth2-client-credentials-m2m-specialist` — closed by its fix (see that issue's Resolved comment).
