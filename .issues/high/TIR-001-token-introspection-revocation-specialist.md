---
ID: "TIR-001"
Title: "No RFC 7662 introspection endpoint; the only live-check is never wired to HTTP"
Level: high
Category: "security"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:29"
Auditor: "token-introspection-revocation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TIR-001 — No RFC 7662 introspection endpoint; the only live-check is never wired to HTTP

`HIGH` · `security` · `jwt` · reported by **Token Introspection & Revocation Specialist** (`token-introspection-revocation-specialist`)

Status: **resolved**

## Summary

The JWT API exposes exactly two endpoints, /jwt/jwks and /jwt/token (packages/jwt/src/JwtApi.ts:37-49); nothing answers 'is this token still valid'. verifyLive (ticket 12) is the only revocation-aware check, but its own header states it is never wired to an HTTP handler, and it further requires the caller to host Sessions in-process. A resource server consuming minted JWTs therefore has no protocol surface for liveness: no introspection endpoint, no deny-list lookup, nothing. This is precisely the persona's core domain gap - introspection is a query endpoint with its own authorization model (caller must be authorized to ask), and it is absent, so every downstream service must blindly trust tokens until exp.

## Evidence

Source: `packages/jwt/src/Jwt.ts:29`

```
// sign/verify/jwks work with zero other plugins installed). It is never
// wired to an HTTP handler, so `HttpApiBuilder.group`'s discharge
```

## Recommended fix

Add an authenticated /jwt/introspect endpoint (RFC 7662 shape: active boolean plus minimal claims) that routes through verifyLive, gated by Authentication or a plugin-scoped service credential so arbitrary callers cannot probe tokens. Add a narrow Sessions.isLive(sid) primitive so the check is O(1) rather than a user-wide list scan.

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

**Decision (2026-09-19):** Resolved via [Token lifecycle store: revocation denylist, introspection endpoint, refresh-token reuse detection & families](../../.scratch/resolve-ready-for-human-findings/issues/11-token-lifecycle-store.md) — adds RFC 7662-shaped `POST /jwt/introspect` (gated by `Api.Authentication`, same as `/jwt/token`) backed by a new `RevocationStore` and an `introspectLive` method reusing `verifyLive`'s session-liveness check. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/jwt/src/JwtApi.ts` still declares exactly two endpoints (`jwks`, `token`); no introspect endpoint exists, and `verifyLive` (`Jwt.ts:274`) is never referenced by any `HttpApiGroup`. The header comment at `Jwt.ts:27-29` matches the evidence quote verbatim. Real gap, but deciding the introspection endpoint's authorization model (who may probe token liveness) is a security/product decision, not a mechanical patch. Status → ready-for-human.

**Resolved (2026-09-19):** Implemented per the decision ticket, with one deliberate deviation. Added a UUIDv7 `jti` claim to every minted token (`Jwt.ts`'s `signClaims`); a new `packages/jwt/src/RevocationStore.ts` port (`revoke`/`isRevoked`, `layerMemory` + `layerSql`, lazy-expiry-on-read matching `Verification.ts`); new `JwtShape.introspect`/`introspectLive` methods (RFC 7662 `{active, claims?}` shape); a new `POST /jwt/introspect` endpoint on `JwtTokenGroup`, gated by `Api.Authentication` exactly like `/jwt/token`.

Deviation from the ticket's point 4: the HTTP endpoint calls `introspect` (RevocationStore-only), not `introspectLive` (RevocationStore + session-liveness). Reason, discovered while implementing: `HttpApiBuilder.group` wraps any handler-referenced `R` not already captured in the plugin's `make` into an internal `Request.From<"Requires", R>` marker that ordinary `Layer.provide`/`provideMerge` cannot discharge (only `HttpRouter.provideRequest` can) — the exact constraint `verifyLive`'s own header comment already sidesteps by simply never being wired to a handler. Wiring `introspectLive` (which carries `Sessions` as its own uncaptured `R`, matching `verifyLive`) into the handler would have forced every future `Jwt` composition to also solve that `Request.From` discharge, a new and undocumented burden with no other precedent in this codebase. Capturing `RevocationStore` once in `make` (same pattern as `JwtConfig`/`KeyRing`) keeps `introspect`'s own `R = never` and the endpoint safely wired; `introspectLive` remains available as a programmatic, in-process superset (same shape as `verifyLive` itself) for a caller that also wants the live-session check. `RevocationStore` is consequently now a mandatory port for every `Jwt` composition (like `SigningKeyRecords`/`KeyRing` already are), not the "optional dependency" TRBS-001's own recommended-fix text suggested — an accepted, documented tradeoff, not an oversight.

Also closed a pre-existing, unrelated gap discovered while designing the new tables' migration: no production migration existed anywhere for `jwt_signing_key` (only an inline `CREATE TABLE` in `KeyRing.test.ts`'s own test setup) — `Jwt`'s plugin class now declares both `jwt_signing_key` and `jwt_token_revocation` via a real `migrations` array (this plugin's first — no plugin in this codebase populated `migrations` before now), verified end-to-end against a fresh SQLite DB in `packages/jwt/test/RevocationStore.test.ts`.

TDD: every new behavior verified fail-then-pass, including a genuine mutation test (`isRevoked` hardcoded to `false`) that correctly failed the revocation test before being reverted. Full monorepo `pnpm run typecheck` and `pnpm run test` both green (641 tests). RRS-003 (the core-package `Sessions` tombstone/family/reuse-detection half of this same decision ticket) is a separate, not-yet-started piece of work — left `ready-for-agent`, not part of this change.
