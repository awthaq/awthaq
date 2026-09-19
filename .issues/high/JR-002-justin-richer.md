---
ID: "JR-002"
Title: "Documented JWKS refetch-on-kid-miss is dead code: findKey falls back to the first RSA key, so provider key rotation bricks id_token verification until restart"
Level: high
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/Jwt.ts:101"
Auditor: "justin-richer"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JR-002 — Documented JWKS refetch-on-kid-miss is dead code: findKey falls back to the first RSA key, so provider key rotation bricks id_token verification until restart

`HIGH` · `correctness` · `oauth` · reported by **Justin Richer — OAuth2/OIDC Contributor, Co-author of "OAuth 2 in Action"** (`justin-richer`)

Status: **resolved**

## Summary

OAuth.ts:256-261 documents 'A kid cache miss gets exactly one refetch — the provider may have rotated keys', but the refetch only triggers when `Jwt.findKey` FAILS, and findKey only fails when the cached JWKS contains zero RSA-key candidates; an unknown-but-present kid silently resolves to `candidates[0]`. After a provider rotates keys (new kid published, old cached), every id_token verifies against the wrong key, signature check fails, and the flow returns OAuthCallbackFailed permanently — the JWKS cache is an in-memory Ref with no TTL (OAuth.ts:249,253). The correct pattern already exists one package over: jwt/verify.ts:105-114 catches the 'unknown kid' error reason and refetches, and that module's header explicitly calls this oauth file out as predating the convention. This is exactly the token-refresh edge case implementers get wrong: recovery code that cannot fire.

## Evidence

Source: `packages/oauth/src/Jwt.ts:101`

```
const matched =
    kid === undefined
      ? (candidates.find((key) => key.kid === kid) ?? candidates[0]);
```

## Recommended fix

Make findKey fail (or return an Option) when a non-undefined kid matches no candidate, reserving the candidates[0] fallback only for kid-less tokens; the existing catch-and-refetch in verifyIdToken then works as documented. Alternatively reuse JwtCodec-style verify with an 'unknown kid' failure reason and mirror verify.ts's retry.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth protocol semantics
- Full dossier: [`justin-richer`](../../.reports/justin-richer/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-002` — Jwt.findKey falls back to the first RSA key on kid mismatch, making the rotation refetch unreachable](medium/AP-002-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AH-001` — Unvalidated JWT header cast turns attacker-controlled input into an unhandled defect](high/AH-001-anders-hejlsberg.md) `_(anders-hejlsberg, high)_`
- [`ACS-003` — OIDC key selection falls back to the first RSA key on kid mismatch](low/ACS-003-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`AOMS-005` — Upstream id_token verification is RS256-only](medium/AOMS-005-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, medium)_`
- [`ERAS-007` — The single node: reference in shipped src is a type-only import (edge-safe, but worth pinning)](info/ERAS-007-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`ESS-004` — oauth/Jwt.ts decodes untrusted JWS segments by cast; null header becomes a defect](medium/ESS-004-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`ESS-007` — kid-mismatch falls back to first JWKS key, contradicting the repo's own key-selection rule](low/ESS-007-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`JJS-001` — OAuth findKey kid-miss fallback defeats JWKS refetch: provider key rotation breaks all OIDC logins until restart](high/JJS-001-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, high)_`
- … 4 more findings touch `packages/oauth/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED, with a minor evidence caveat — the actual code at `packages/oauth/src/Jwt.ts:98-101` is `kid === undefined ? candidates[0] : (candidates.find((key) => key.kid === kid) ?? candidates[0])`; the quoted block collapses/reorders the two ternary branches (drops the `candidates[0]` true-branch line and misattributes the `find(...) ?? candidates[0]` fallback to the `kid === undefined` condition) rather than quoting verbatim. The underlying claim is nonetheless accurate: a present-but-unmatched `kid` does silently fall back to `candidates[0]`, `OAuth.ts:256-261`'s refetch only engages via `Effect.catch` on `findKey` failure (which requires an empty candidate set), and this is the same defect independently confirmed for JJS-001. Status → ready-for-agent.

**Resolved (2026-09-19):** `Jwt.findKey` now fails when a *present* `kid` matches no JWKS candidate — the `?? candidates[0]` fallback applies only to a `kid`-less token, restoring symmetric strictness with `@awthaq/jwt`'s own `JwtCodec.verify`. This makes `verifyIdToken`'s already-documented "refetch once on a `kid` cache miss" path (an `Effect.catch` around `findKey`) actually reachable for the first time. Also added a 15-minute TTL to the in-memory JWKS cache (`OAuth.ts`) so a provider-*removed* key (no new kid ever presented, so no cache miss to catch it) still converges without a process restart — the secondary hardening all four auditors additionally recommended. Added two regression tests: an unregistered-`kid` token (genuinely signed by the JWKS's one real key) now fails `OAuthCallbackFailed` instead of silently verifying against the wrong-selector key; a same-process key-rotation round trip (stale cache after round 1, provider serves only the new key by round 2) now succeeds via the refetch path instead of failing forever. Both confirmed red against the pre-fix code via a temporary revert before re-applying. Full `@awthaq/oauth` suite (34 tests) and monorepo typecheck pass. Status → resolved.
