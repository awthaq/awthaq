---
ID: "MAPS-002"
Title: "No token introspection endpoint - downstream revocation checking requires importing the session store"
Level: high
Category: "architecture"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/verify.ts:23"
Auditor: "microservices-auth-propagation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MAPS-002 — No token introspection endpoint - downstream revocation checking requires importing the session store

`HIGH` · `architecture` · `jwt` · reported by **Microservices Auth Propagation Specialist** (`microservices-auth-propagation-specialist`)

Status: **resolved**

## Summary

A downstream service has exactly two options. Signature-only (makeVerifier): immediate and cheap, but a revoked session's token keeps verifying until its own exp - a revocation lag equal to the full TTL. verifyLive: immediate revocation, but it requires Sessions in-process, collapsing the service boundary and reattaching the downstream service to the shared session store on every check. The middle path - an RFC 7662-style introspection endpoint the edge itself exposes (JwtApi declares only GET /jwt/jwks and GET /jwt/token) - does not exist, so the tradeoff my persona lives in (self-contained speed vs introspection immediacy) is unresolvable per-deployment.

## Evidence

Source: `packages/jwt/src/verify.ts:23`

```
// No `verifyLive`-equivalent exists here, and none should be added — a
// live revocation check needs `Sessions`, which this module cannot depend
```

## Recommended fix

Add POST /jwt/introspect to the jwt.token group (authenticated with the signing key's own trust or an internal credential), backed by a direct sid lookup, returning active: true/false plus minimal claims. Downstream services then choose per-route: lite verify for low-risk paths, introspection for high-value ones.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: Service Boundary Auth Propagation
- Full dossier: [`microservices-auth-propagation-specialist`](../../.reports/microservices-auth-propagation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ECF-002` — Unknown-kid JWKS refetch runs once per request with no single-flight, TTL, or negative caching](high/ECF-002-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, high)_`
- [`JJS-002` — Lite-verifier JWKS cache never expires: keys removed from the JWKS stay trusted indefinitely](medium/JJS-002-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, medium)_`
- [`KRS-010` — Lite verifier's JWKS cache never expires keys and the served JWKS sets no caching guidance](low/KRS-010-key-rotation-specialist.md) `_(key-rotation-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Token lifecycle store: revocation denylist, introspection endpoint, refresh-token reuse detection & families](../../.scratch/resolve-ready-for-human-findings/issues/11-token-lifecycle-store.md) — a new `jti`-keyed `RevocationStore` port plus `introspect`/`introspectLive` `JwtShape` methods back a new `POST /jwt/introspect` endpoint, letting a resource server ask token liveness over HTTP without needing local `Sessions`. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `verify.ts:23-27` matches the evidence verbatim, and confirms by design there is no `verifyLive` equivalent since this module cannot depend on `Sessions`. `packages/jwt/src/JwtApi.ts:38,45` shows exactly two endpoints, `GET /jwt/jwks` and `GET /jwt/token`; no introspection route exists. This is a real, deliberate architectural gap (self-contained verify vs. live revocation), and closing it requires a product decision about introspection endpoint design/trust model, not a small patch. Status → ready-for-human.

**Resolved (2026-09-19):** Same fix as [TIR-001](TIR-001-token-introspection-revocation-specialist.md) — see that finding's comment for full detail. `POST /jwt/introspect` now exists on `JwtTokenGroup`, gated by `Api.Authentication` exactly like the existing `/jwt/token` mint endpoint — the RFC 7662-shaped middle path this finding asked for (self-contained lite verify for low-risk paths, introspection for high-value ones). A downstream resource server with no local `Sessions` still never has to host this endpoint itself; it calls the issuer's own `/jwt/introspect` over HTTP instead (this finding's own persona lens, RFC 7662's standard topology). Full monorepo typecheck + test suite green.
