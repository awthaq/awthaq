---
ID: "JJS-001"
Title: "OAuth findKey kid-miss fallback defeats JWKS refetch: provider key rotation breaks all OIDC logins until restart"
Level: high
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/Jwt.ts:101"
Auditor: "jwt-jwk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# JJS-001 — OAuth findKey kid-miss fallback defeats JWKS refetch: provider key rotation breaks all OIDC logins until restart

`HIGH` · `security` · `oauth` · reported by **JWT/JWK Specialist** (`jwt-jwk-specialist`)

Status: **resolved**

## Summary

findKey never reports an unknown kid when the JWKS contains any RSA candidate — it silently substitutes candidates[0]. verifyIdToken's refetch (OAuth.ts:259-261) is wired to Effect.catch on findKey failure, so it can only fire when the key set is empty, never on a kid cache miss. Combined with the process-lifetime jwksCache Ref (OAuth.ts:410, no TTL, no eviction), a provider that rotates signing keys leaves every cached old key in place: new-kid tokens verify against the wrong key, fail the signature, and every OIDC login fails until the process restarts. Worse on the security side, a key the provider has removed (e.g. after compromise) keeps verifying forever in that cache. The module header's own claim of a 'refetch once on a kid cache miss' policy is dead code because the miss is masked.

## Evidence

Source: `packages/oauth/src/Jwt.ts:101`

```
    kid === undefined
      ? candidates[0]
      : (candidates.find((key) => key.kid === kid) ?? candidates[0]);
```

## Recommended fix

Make findKey fail when kid is present but unmatched (keep the candidates[0] fallback only for kid-less tokens from single-key providers, or drop it entirely); this lets the existing refetch-on-miss engage. Also add a TTL (e.g. 15-60 min) to the provider JWKS cache so removals propagate without an unknown kid.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: JWT/JWK security
- Full dossier: [`jwt-jwk-specialist`](../../.reports/jwt-jwk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-002` — Jwt.findKey falls back to the first RSA key on kid mismatch, making the rotation refetch unreachable](medium/AP-002-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AH-001` — Unvalidated JWT header cast turns attacker-controlled input into an unhandled defect](high/AH-001-anders-hejlsberg.md) `_(anders-hejlsberg, high)_`
- [`ACS-003` — OIDC key selection falls back to the first RSA key on kid mismatch](low/ACS-003-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`AOMS-005` — Upstream id_token verification is RS256-only](medium/AOMS-005-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, medium)_`
- [`ERAS-007` — The single node: reference in shipped src is a type-only import (edge-safe, but worth pinning)](info/ERAS-007-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`ESS-004` — oauth/Jwt.ts decodes untrusted JWS segments by cast; null header becomes a defect](medium/ESS-004-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`ESS-007` — kid-mismatch falls back to first JWKS key, contradicting the repo's own key-selection rule](low/ESS-007-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`JR-002` — Documented JWKS refetch-on-kid-miss is dead code: findKey falls back to the first RSA key, so provider key rotation bricks id_token verification until restart](high/JR-002-justin-richer.md) `_(justin-richer, high)_`
- … 4 more findings touch `packages/oauth/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/Jwt.ts:98-101` matches the evidence verbatim: `kid === undefined ? candidates[0] : (candidates.find((key) => key.kid === kid) ?? candidates[0])`, so a present-but-unmatched `kid` silently resolves to `candidates[0]` rather than failing. `packages/oauth/src/OAuth.ts:259-261` confirms the refetch is wired via `Effect.catch` on `Jwt.findKey` failure, which (per `findKey`'s logic) can only fire when `candidates` is empty. `OAuth.ts:410` confirms the `jwksCache` `Ref` has no TTL/eviction. Fix (fail `findKey` on kid-present-no-match) is a small, well-scoped, mechanical change. Status → ready-for-agent.

**Resolved (2026-09-19):** `Jwt.findKey` now fails when a *present* `kid` matches no JWKS candidate — the `?? candidates[0]` fallback applies only to a `kid`-less token, restoring symmetric strictness with `@awthaq/jwt`'s own `JwtCodec.verify`. This makes `verifyIdToken`'s already-documented "refetch once on a `kid` cache miss" path (an `Effect.catch` around `findKey`) actually reachable for the first time. Also added a 15-minute TTL to the in-memory JWKS cache (`OAuth.ts`) so a provider-*removed* key (no new kid ever presented, so no cache miss to catch it) still converges without a process restart — the secondary hardening all four auditors additionally recommended. Added two regression tests: an unregistered-`kid` token (genuinely signed by the JWKS's one real key) now fails `OAuthCallbackFailed` instead of silently verifying against the wrong-selector key; a same-process key-rotation round trip (stale cache after round 1, provider serves only the new key by round 2) now succeeds via the refetch path instead of failing forever. Both confirmed red against the pre-fix code via a temporary revert before re-applying. Full `@awthaq/oauth` suite (34 tests) and monorepo typecheck pass. Status → resolved.
