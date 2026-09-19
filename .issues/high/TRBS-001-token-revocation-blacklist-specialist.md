---
ID: "TRBS-001"
Title: "No denylist store exists; stateless JWT verify never consults revocation state"
Level: high
Category: "security"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:65"
Auditor: "token-revocation-blacklist-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TRBS-001 — No denylist store exists; stateless JWT verify never consults revocation state

`HIGH` · `security` · `jwt` · reported by **Token Revocation & Blacklist Specialist** (`token-revocation-blacklist-specialist`)

Status: **resolved**

## Summary

The repo contains no blacklist/denylist store of any kind, and `verify`'s error+environment signature shows it is fully stateless — it checks signature, issuer, audience, and exp against the KeyRing alone, with no channel to any revocation state (R = never, no Sessions). The code and .scratch/jwt/spec.md both call the consequence a 'documented, deliberate weakening': after `sessions.revoke`, a JWT naming that session keeps verifying until its own exp (default 15 minutes, JwtConfig.ts:46). The sole mitigation, `verifyLive` (Jwt.ts:274), is opt-in per caller, requires the caller to supply Sessions at the call site, and is never wired to any HTTP handler — JwtHandlers exposes only jwks and mint. For every consumer verifying through `verify` or the lite verifier (verify.ts explicitly rules out a live check, verify.ts:23-27), there is no revocation path at all, only a TTL-bounded exposure window.

## Evidence

Source: `packages/jwt/src/Jwt.ts:65`

```
readonly verify: (
    token: string,
  ) => Effect.Effect<Record<string, unknown>, JwtCodec.JwtInvalidError>;
```

## Recommended fix

Add a RevocationStore port (TTL-bounded denylist keyed by token id, entries self-pruning on the token's own exp so no cleanup job is needed) and consult it in `verify`; make it an optional dependency so stateless-only deployments still compose. Until then, keep `verifyLive` as the only blessed path and say so in the readme-level docs.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Token Revocation
- Full dossier: [`token-revocation-blacklist-specialist`](../../.reports/token-revocation-blacklist-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

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

**Decision (2026-09-19):** Resolved via [Token lifecycle store: revocation denylist, introspection endpoint, refresh-token reuse detection & families](../../.scratch/resolve-ready-for-human-findings/issues/11-token-lifecycle-store.md) — new `jti`-keyed `RevocationStore` port (`packages/jwt/src/RevocationStore.ts`, memory + SQL layers), self-pruning via the same lazy-expiry read pattern `Verification.ts` already uses, consulted by new `introspect`/`introspectLive` methods; stateless `verify` stays unchanged/fast by design. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `verify`'s signature at `packages/jwt/src/Jwt.ts:65-67` matches the evidence exactly; repo-wide grep for denylist/blacklist/revocation-store terms returns nothing, and `packages/jwt/src/verify.ts:23-27` explicitly documents the lite verifier has no live-check path by design. Real gap, but the recommended fix (a new `RevocationStore` port with a TTL-bounded, self-pruning denylist schema) is a new subsystem design, not a mechanical patch. Status → ready-for-human.

**Resolved (2026-09-19):** Same fix as [TIR-001](TIR-001-token-introspection-revocation-specialist.md) — see that finding's comment for full detail. In short: new `jti`-keyed `RevocationStore` port (`packages/jwt/src/RevocationStore.ts`, `layerMemory` + `layerSql`, lazy-expiry-on-read), consulted by the new `introspect`/`introspectLive` methods and the new `POST /jwt/introspect` endpoint. Stateless `verify` is genuinely unchanged (still `R = never`, still fast, still revocation-lagging by design) — but `RevocationStore` is now a mandatory port for every `Jwt` composition, not the "optional dependency" this finding's own recommended fix suggested (see TIR-001's comment for why). Full monorepo typecheck + test suite green.
