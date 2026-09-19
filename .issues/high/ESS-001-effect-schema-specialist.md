---
ID: "ESS-001"
Title: "OAuth JWKS fetch decoded by double cast instead of a schema"
Level: high
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:248"
Auditor: "effect-schema-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-001 — OAuth JWKS fetch decoded by double cast instead of a schema

`HIGH` · `correctness` · `oauth` · reported by **Effect Schema Specialist** (`effect-schema-specialist`)

Status: **resolved**

## Summary

The provider's JWKS document — untrusted network input fetched on the callback path — is cast through `as unknown as Jwt.Jwks` with no runtime validation, then cached and fed to `Jwt.findKey`, which filters on `key.kty`/`key.kid` of arbitrarily-shaped values. The hiring rubric's red flag ('type assertions to silence a decode mismatch') applies literally, and the repo's own reference idiom exists one package away: packages/jwt/src/verify.ts:51-53 defines JwksDocumentSchema and decodes the same document shape via Schema.decodeUnknownEffect.

## Evidence

Source: `packages/oauth/src/OAuth.ts:248`

```
Effect.map((body) => body as unknown as Jwt.Jwks),
```

## Recommended fix

Port verify.ts's JwksDocumentSchema (keys: Array(Record(String, Unknown))) into oauth and decode via HttpIncomingMessage.schemaBodyJson or Schema.decodeUnknownEffect, mapping decode failure to OAuthCallbackFailed like every other check in verifyIdToken.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Schema discipline
- Full dossier: [`effect-schema-specialist`](../../.reports/effect-schema-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-001` — Scheme-relative //host callbackURL bypasses the trusted-origin allowlist (open redirect)](high/AP-001-aaron-parecki.md) `_(aaron-parecki, high)_`
- [`AP-003` — id_token aud accepted only as an exact string; array-form audiences rejected](medium/AP-003-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-004` — Userinfo claims merged over id_token claims without the required sub equality check](medium/AP-004-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-006` — Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored](medium/AP-006-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-008` — Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires](low/AP-008-aaron-parecki.md) `_(aaron-parecki, low)_`
- [`AH-002` — JWKS response cast wholesale with as unknown as and cached unvalidated](medium/AH-002-anders-hejlsberg.md) `_(anders-hejlsberg, medium)_`
- [`AGA-001` — OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer](high/AGA-001-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, high)_`
- [`AGA-005` — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL](low/AGA-005-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, low)_`
- … 65 more findings touch `packages/oauth/src/OAuth.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/OAuth.ts:248` still reads `Effect.map((body) => body as unknown as Jwt.Jwks),` verbatim, with no runtime validation before the result is cached (line ~250) and consumed by `Jwt.findKey`. `packages/jwt/src/verify.ts:51-57,84` confirms the repo's own reference idiom (`JwksDocumentSchema` + `HttpIncomingMessage.schemaBodyJson`) already exists one package over. Fix is a direct, mechanical port of that idiom. Status → ready-for-agent.

**Resolved (2026-09-19):** `packages/oauth/src/Jwt.ts` now exports `JwksDocumentSchema` (`{ keys: Array(Record(String, Unknown)) }`, mirroring `packages/jwt/src/verify.ts`'s own established idiom for the identical shape); `OAuth.ts:246` decodes the fetched JWKS body via `HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema)` instead of `response.json` + `as unknown as Jwt.Jwks`, with a decode failure now mapped to the same typed `OAuthCallbackFailed` every other check in `verifyIdToken` already uses. `findKey`/`verifyRs256` updated to work off the schema-derived `Record<string, unknown>` entries. Added a regression test (a malformed `{ keys: "not-an-array" }` JWKS response, previously would have laundered through the cast into a defect-shaped crash in `findKey`, now fails typed as `OAuthCallbackFailed`) — TDD: confirmed the new test passes against the fix, full `@awthaq/oauth` suite (32 tests) and monorepo typecheck pass. Note: the sibling casts GC-001 also mentions (`OAuth.ts:211`'s token-response body, `Jwt.ts`'s id_token header/payload) are separately tracked at medium severity (ESS-003/004, TTE-002, JJS-005, OIT-005, OAP-004) and left for that pass — out of this cluster's scope, which is specifically the JWKS cast at OAuth.ts:248. Status → resolved.
