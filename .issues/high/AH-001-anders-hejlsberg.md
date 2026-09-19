---
ID: "AH-001"
Title: "Unvalidated JWT header cast turns attacker-controlled input into an unhandled defect"
Level: high
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/Jwt.ts:63"
Auditor: "anders-hejlsberg"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-001 — Unvalidated JWT header cast turns attacker-controlled input into an unhandled defect

`HIGH` · `correctness` · `oauth` · reported by **Anders Hejlsberg — Creator/Lead Architect of TypeScript** (`anders-hejlsberg`)

Status: **resolved**

## Summary

Jwt.decode JSON.parses each token segment and asserts the result, so a header segment encoding the JSON literal `null` (fully attacker-chosen, since this runs before signature verification) yields header === null while the type claims { alg?; kid? }. The very next dereference, `decoded.header.alg !== "RS256"` (packages/oauth/src/OAuth.ts:242), executes inside Effect.gen but outside any Effect.try, so the TypeError surfaces as a fiber defect (HTTP 500) instead of the typed OAuthCallbackFailed (400) the module's error channel promises. A null payload likewise reaches `claims["iss"]` (OAuth.ts:271) as a defect. The cast is the root cause: the compiler was told the shape is guaranteed, so no narrowing was emitted.

## Evidence

Source: `packages/oauth/src/Jwt.ts:63`

```
header: decodeJson(headerSegment) as DecodedJwt["header"],
payload: decodeJson(payloadSegment) as Record<string, unknown>,
```

## Recommended fix

Decode both segments with an effect/Schema struct (alg/kid as strings, payload as Record) and fail with JwtVerificationError on mismatch, exactly like the existing `parts.length !== 3` guard; then the alg/kid checks stay pre-verification but malformed headers become typed failures.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 74/100), domain: Type system design
- Full dossier: [`anders-hejlsberg`](../../.reports/anders-hejlsberg/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-002` — Jwt.findKey falls back to the first RSA key on kid mismatch, making the rotation refetch unreachable](medium/AP-002-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`ACS-003` — OIDC key selection falls back to the first RSA key on kid mismatch](low/ACS-003-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`AOMS-005` — Upstream id_token verification is RS256-only](medium/AOMS-005-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, medium)_`
- [`ERAS-007` — The single node: reference in shipped src is a type-only import (edge-safe, but worth pinning)](info/ERAS-007-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`ESS-004` — oauth/Jwt.ts decodes untrusted JWS segments by cast; null header becomes a defect](medium/ESS-004-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`ESS-007` — kid-mismatch falls back to first JWKS key, contradicting the repo's own key-selection rule](low/ESS-007-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`JR-002` — Documented JWKS refetch-on-kid-miss is dead code: findKey falls back to the first RSA key, so provider key rotation bricks id_token verification until restart](high/JR-002-justin-richer.md) `_(justin-richer, high)_`
- [`JJS-001` — OAuth findKey kid-miss fallback defeats JWKS refetch: provider key rotation breaks all OIDC logins until restart](high/JJS-001-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, high)_`
- … 4 more findings touch `packages/oauth/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/Jwt.ts:63-64` casts `decodeJson(...)` results with `as`, unvalidated; `decode` is wrapped in `Effect.try` (lines 57-70), but `JSON.parse("null")` doesn't throw, so a `null` header/payload passes through successfully. `OAuth.ts:242` (`decoded.header.alg !== "RS256"`) and `OAuth.ts:271` (`claims["iss"]`) then dereference it as a plain property access inside `Effect.gen`, outside any `Effect.try`, which becomes an unhandled defect rather than the typed `OAuthCallbackFailed`. Fix (schema-validate both segments) is mechanical. Status → ready-for-agent.

**Resolved (2026-09-20):** `packages/oauth/src/Jwt.ts`'s `decode` now schema-validates both segments instead of casting: `JwtHeaderSchema` (`Schema.Struct({alg: optional string, kid: optional string})`) and `JwtPayloadSchema` (`Schema.Record(string, unknown)`), both exported alongside `DecodedJwt`'s own types now derived from them (`typeof JwtHeaderSchema.Type`/`typeof JwtPayloadSchema.Type`), mirroring this same file's own `JwksDocumentSchema`→`Jwks` idiom immediately above. `Schema.decodeUnknownOption` runs after the existing `Effect.try` (JSON/base64 malformed-input catch), and either segment failing to decode (a `null`, an array, a bare primitive — anything that isn't a genuine object) fails with the same `JwtVerificationError({reason: "malformed JWT"})` the `parts.length !== 3` guard already uses, exactly as the recommended fix asked. No change needed at `OAuth.ts:242/271` — `decoded.header`/`payload` are now genuinely guaranteed non-null objects by the time they're dereferenced, closing the gap between what the type promised and what the runtime actually enforced.

TDD: new `packages/oauth/test/Jwt.test.ts` — a well-formed token decodes correctly; a `null` header, a `null` payload, and a header encoded as a JSON array each fail with a typed `JwtVerificationError` rather than propagating; a too-short token still fails the same way; extra unrecognized header fields (e.g. `typ`/`x5t`) are silently dropped, not rejected (real JWTs always carry more than `alg`/`kid`). Verified to genuinely fail: reverting to the original uncasted pass-through reproduces exactly the finding's own failure shape — the 4 malformed-input tests fail because `decode` succeeds with a `null`/array header/payload instead of failing. Also closes [`ESS-004`](../medium/ESS-004-effect-schema-specialist.md) (medium, same file/defect) — cross-referenced. Full monorepo `pnpm run typecheck` and `pnpm run test` both green (694 passed, 7 skipped).
