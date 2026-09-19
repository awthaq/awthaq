---
ID: "KRS-004"
Title: "OAuth ID-token verification cannot pick up a provider-rotated key; refetch path is unreachable"
Level: high
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/Jwt.ts:101"
Auditor: "key-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# KRS-004 — OAuth ID-token verification cannot pick up a provider-rotated key; refetch path is unreachable

`HIGH` · `correctness` · `oauth` · reported by **Key Rotation Specialist** (`key-rotation-specialist`)

Status: **resolved**

## Summary

findKey falls back to the first RSA key whenever the token's kid matches no cached key, so it only fails when the cached JWKS contains zero RSA keys. The one-refetch-on-kid-miss logic in OAuth.ts:256-261 is therefore dead code for the very case it documents ('the provider may have rotated keys'): after a provider rotates, new-kid tokens are silently checked against the stale cached key, signature verification fails, and every login via that provider returns OAuthCallbackFailed until the process restarts and the cache is rebuilt. It also contradicts the strict unknown-kid-fails discipline the repo's own JwtCodec.verify enforces, and it verifies kid-less or unknown-kid tokens against an arbitrary key rather than failing.

## Evidence

Source: `packages/oauth/src/Jwt.ts:101`

```
kid === undefined
  ? candidates[0]
  : (candidates.find((key) => key.kid === kid) ?? candidates[0]);
```

## Recommended fix

Fail on a kid that matches no candidate (allow the candidates[0] fallback only when the token carries no kid and the JWKS has exactly one key), which makes the existing refetch-on-miss path reachable and restores symmetric strictness with JwtCodec.verify.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: Key lifecycle & rotation
- Full dossier: [`key-rotation-specialist`](../../.reports/key-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/Jwt.ts:98-101` matches the evidence verbatim; `findKey` falls back to `candidates[0]` on any kid mismatch instead of failing. Since `Jwt.findKey` only fails when `candidates` is empty, the `Effect.catch` refetch-on-miss at `OAuth.ts:256-261` is unreachable for the documented "provider rotated keys" case — a kid miss silently verifies against the wrong (stale) key instead of triggering refetch. Fix is a well-scoped, mechanical change to `findKey`'s fallback condition. Status → ready-for-agent.

**Resolved (2026-09-19):** `Jwt.findKey` now fails when a *present* `kid` matches no JWKS candidate — the `?? candidates[0]` fallback applies only to a `kid`-less token, restoring symmetric strictness with `@awthaq/jwt`'s own `JwtCodec.verify`. This makes `verifyIdToken`'s already-documented "refetch once on a `kid` cache miss" path (an `Effect.catch` around `findKey`) actually reachable for the first time. Also added a 15-minute TTL to the in-memory JWKS cache (`OAuth.ts`) so a provider-*removed* key (no new kid ever presented, so no cache miss to catch it) still converges without a process restart — the secondary hardening all four auditors additionally recommended. Added two regression tests: an unregistered-`kid` token (genuinely signed by the JWKS's one real key) now fails `OAuthCallbackFailed` instead of silently verifying against the wrong-selector key; a same-process key-rotation round trip (stale cache after round 1, provider serves only the new key by round 2) now succeeds via the refetch path instead of failing forever. Both confirmed red against the pre-fix code via a temporary revert before re-applying. Full `@awthaq/oauth` suite (34 tests) and monorepo typecheck pass. Status → resolved.
