---
ID: "NAM-001"
Title: "No stateless JWT session strategy: Jwt plugin still requires the live Sessions store"
Level: high
Category: "architecture"
Status: ready-for-agent
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:68"
Auditor: "nextauth-authjs-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NAM-001 — No stateless JWT session strategy: Jwt plugin still requires the live Sessions store

`HIGH` · `architecture` · `jwt` · reported by **NextAuth.js/Auth.js Migration Specialist** (`nextauth-authjs-migration-specialist`)

Status: **ready-for-agent**

## Summary

Auth.js's `session: { strategy: "jwt" }` exists precisely so an app can authenticate without a session database; effect-auth's Jwt plugin is instead a delegation credential minted from a live session (it carries `sid`, and only `verifyLive` checks revocation — bare `verify` trusts the token until its 15-minute exp). An app migrating off Auth.js JWT strategy for edge/stateless reasons keeps the entire SQL persistence requirement: Sessions.layerSql, repositories, migrations, and a driver. Revocation lag on `verify` (up to ttl=15m, JwtConfig.ts:46) is the same tradeoff Auth.js makes, but Auth.js pairs it with true statelessness; effect-auth pairs it with a mandatory database, which is the worse half of both strategies for a migrant. This is the single largest architectural divergence an Auth.js JWT-strategy app must absorb.

## Evidence

Source: `packages/jwt/src/Jwt.ts:68`

```
/** Ticket 12: `verify` plus a live check that the token's `sid` still names an unrevoked, unexpired session. The documented, deliberate weakening `verify` alone carries (a revoked session's JWT keeps verifying until its own `exp`) does not apply here. */
readonly verifyLive: (
  token: string,
```

## Recommended fix

Document the divergence explicitly as a migration decision (JWT-as-delegation vs JWT-as-session) in the package README, and either (a) ship an optional stateless verify profile with a documented revocation-lag bound, or (b) publish an edge deployment recipe (edge-safe session verification path without layerSql).

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: Auth.js Migration Parity
- Full dossier: [`nextauth-authjs-migration-specialist`](../../.reports/nextauth-authjs-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-012` — Sessions and JWTs carry no authentication-method record (no amr/acr equivalent)](low/AOMS-012-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, low)_`
- [`FAMS-009` — verifyLive scans all of a user's sessions per token check](low/FAMS-009-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- [`JH-008` — Ports-never-provided sandboxing rule is convention, not an enforced boundary](low/JH-008-jared-hanson.md) `_(jared-hanson, low)_`
- [`MAPS-005` — x-jwt-token mirrored onto every authenticated response hands out a portable credential silently](medium/MAPS-005-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`MAPS-006` — verifyLive live-check scans every session of the subject user to find one sid](medium/MAPS-006-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`OCM-006` — JWT mint is exclusively session-bound — no path issues a token to a machine credential](info/OCM-006-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, info)_`
- [`OCM-007` — No immediate revocation story exists for machine credentials; the only revocation-aware verify is session-scoped](low/OCM-007-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, low)_`
- [`PDR-003` — JWT plugin mirrors a bearer token onto every authenticated response via x-jwt-token with no opt-out](medium/PDR-003-philippe-de-ryck.md) `_(philippe-de-ryck, medium)_`
- … 11 more findings touch `packages/jwt/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — packages/jwt/src/Jwt.ts:65-71/253-267 confirms bare `verify` never touches `Sessions` (pure `JwtCodec.verify` against `KeyRing`, R=never); only `verifyLive` (Jwt.ts:274-298) requires `Sessions.Sessions`. `verify` alone is already stateless, and `Jwt.dependsOn: []` (Jwt.ts header) means the plugin can install without Sessions — narrower than "entire SQL persistence requirement" as literally stated — but the real gap (no documented/supported pure-stateless deployment profile comparable to Auth.js's `strategy: "jwt"`) is real. Deciding whether to ship a stateless profile or just document the tradeoff is a product/architecture call. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Stateless JWT-as-bearer session strategy](../../.scratch/resolve-ready-for-human-findings/issues/33-stateless-jwt-session-strategy.md) — the documented stateless profile is `Sessions.layerMemory` (no SQL) + `Jwt` with the new `acceptAsBearer: true` flag, so `Authentication`'s structural `Sessions.Sessions` requirement is satisfied without ever being exercised on the JWT-bearer request path; a README recipe in `packages/jwt` documents this plus the `verify`-alone revocation-lag bound. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `jwt-stateless-bearer-reentry`. Evidence at HEAD ec065a7: `packages/jwt/src/JwtConfig.ts:25`. Fix: Implement .scratch/resolve-ready-for-human-findings/issues/33-stateless-jwt-session-strategy.md verbatim: a `BearerCredentialResolver` slot on `Authentication`, a default-off `JwtConfig.acceptAsBearer`, `signJWT({ audience })`, and a README stateless recipe. (effort L). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`.
