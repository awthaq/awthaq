---
ID: "OIT-002"
Title: "kid mismatch silently falls back to the first RSA key, disabling the refetch-on-miss rotation path"
Level: high
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/Jwt.ts:101"
Auditor: "oidc-id-token-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OIT-002 — kid mismatch silently falls back to the first RSA key, disabling the refetch-on-miss rotation path

`HIGH` · `correctness` · `oauth` · reported by **OIDC ID Token Specialist** (`oidc-id-token-specialist`)

Status: **resolved**

## Summary

When the token carries a kid that matches no JWKS entry, findKey returns candidates[0] instead of failing. Consequence one: the refetch-on-miss in verifyIdToken (OAuth.ts:256-261) only fires when findKey FAILS, i.e. only when the cached JWKS holds zero RSA keys at all — a stale cache with any RSA key never refetches. Consequence two: when a provider rotates keys (old key removed, new kid published), every subsequent login verifies the new-kid token against the stale first key, the signature check fails, and the user gets OAuthCallbackFailed — permanently, until the process restarts and the Ref-backed cache (OAuth.ts:410) is rebuilt. Consequence three: a mismatched-kid token is verified against an arbitrary key rather than being rejected, which defeats kid's purpose as an explicit key selector and invites key-confusion bugs in multi-key JWKS.

## Evidence

Source: `packages/oauth/src/Jwt.ts:101`

```
: (candidates.find((key) => key.kid === kid) ?? candidates[0]);
```

## Recommended fix

In findKey, return a failure when kid is present and no entry matches (keep the candidates[0] fallback only for kid === undefined); the existing Effect.catch refetch in verifyIdToken then works as documented. Additionally give the JWKS cache a TTL so long-running processes converge after rotation even without a cache miss.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: OIDC id_token validation
- Full dossier: [`oidc-id-token-specialist`](../../.reports/oidc-id-token-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 7 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/Jwt.ts:101` matches the evidence exactly; `findKey` falls back to `candidates[0]` when `kid` is present but unmatched, and `packages/oauth/src/OAuth.ts:256-261`'s refetch-on-miss only triggers when `findKey` fails (empty candidate set), never on a kid mismatch with a stale cache. Status → ready-for-agent.

**Resolved (2026-09-19):** `Jwt.findKey` now fails when a *present* `kid` matches no JWKS candidate — the `?? candidates[0]` fallback applies only to a `kid`-less token, restoring symmetric strictness with `@awthaq/jwt`'s own `JwtCodec.verify`. This makes `verifyIdToken`'s already-documented "refetch once on a `kid` cache miss" path (an `Effect.catch` around `findKey`) actually reachable for the first time. Also added a 15-minute TTL to the in-memory JWKS cache (`OAuth.ts`) so a provider-*removed* key (no new kid ever presented, so no cache miss to catch it) still converges without a process restart — the secondary hardening all four auditors additionally recommended. Added two regression tests: an unregistered-`kid` token (genuinely signed by the JWKS's one real key) now fails `OAuthCallbackFailed` instead of silently verifying against the wrong-selector key; a same-process key-rotation round trip (stale cache after round 1, provider serves only the new key by round 2) now succeeds via the refetch path instead of failing forever. Both confirmed red against the pre-fix code via a temporary revert before re-applying. Full `@awthaq/oauth` suite (34 tests) and monorepo typecheck pass. Status → resolved.
