---
ID: "GC-001"
Title: "OAuth plugin decodes untrusted IdP responses with type assertions instead of Schema"
Level: high
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:248"
Auditor: "giulio-canti"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# GC-001 — OAuth plugin decodes untrusted IdP responses with type assertions instead of Schema

`HIGH` · `correctness` · `oauth` · reported by **Giulio Canti — Creator of fp-ts and io-ts** (`giulio-canti`)

Status: **resolved**

## Summary

The JWKS document fetched from an external identity provider is parsed with `response.json` and forced into `Jwt.Jwks` by a double assertion; the token-endpoint body gets the same treatment (`(yield* response.json) as { access_token?: string; ... }`, OAuth.ts:211) and the id_token header/payload in packages/oauth/src/Jwt.ts:63-64 are `JSON.parse` plus `as` casts. This is precisely the red flag the codec discipline exists to prevent: the runtime check and the static type are connected by assertion, so any drift between what the IdP actually sends and `Jwt.Jwks` surfaces as undefined behavior deep in key matching rather than as a typed decode failure. It also violates the repo's own standing rule — Password.ts:133 states the repo 'forbids `as`/`as unknown as`/`as any` in library source', and @awthaq/jwt's JwtCodec.ts:19-21 explicitly says the rule 'applies to untrusted wire data even more than anywhere else'.

## Evidence

Source: `packages/oauth/src/OAuth.ts:248`

```
Effect.map((body) => body as unknown as Jwt.Jwks),
```

## Recommended fix

Declare a JwksSchema (and a TokenResponseSchema, and header/payload schemas) and decode with Schema.decodeUnknownEffect, exactly as JwtCodec.ts already does for its own header — one idiom for the whole repo, with OAuthCallbackFailed as the mapped error.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: functional design
- Full dossier: [`giulio-canti`](../../.reports/giulio-canti/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/OAuth.ts:248` (`body as unknown as Jwt.Jwks`) matches verbatim; the token-endpoint cast is confirmed at `OAuth.ts:211-214` (`(yield* response.json) as { readonly access_token?: string; ... }`), and `packages/oauth/src/Jwt.ts:63-64` confirms `decodeJson(headerSegment) as DecodedJwt["header"]` / `decodeJson(payloadSegment) as Record<string, unknown>`. `Password.ts:~131-134` and `packages/jwt/src/JwtCodec.ts:19-21` both confirm the cited standing rule/idiom. Mechanical schema-decode fix, same pattern already used in `packages/jwt/src/verify.ts`. Status → ready-for-agent.

**Resolved (2026-09-19):** `packages/oauth/src/Jwt.ts` now exports `JwksDocumentSchema` (`{ keys: Array(Record(String, Unknown)) }`, mirroring `packages/jwt/src/verify.ts`'s own established idiom for the identical shape); `OAuth.ts:246` decodes the fetched JWKS body via `HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema)` instead of `response.json` + `as unknown as Jwt.Jwks`, with a decode failure now mapped to the same typed `OAuthCallbackFailed` every other check in `verifyIdToken` already uses. `findKey`/`verifyRs256` updated to work off the schema-derived `Record<string, unknown>` entries. Added a regression test (a malformed `{ keys: "not-an-array" }` JWKS response, previously would have laundered through the cast into a defect-shaped crash in `findKey`, now fails typed as `OAuthCallbackFailed`) — TDD: confirmed the new test passes against the fix, full `@awthaq/oauth` suite (32 tests) and monorepo typecheck pass. Note: the sibling casts GC-001 also mentions (`OAuth.ts:211`'s token-response body, `Jwt.ts`'s id_token header/payload) are separately tracked at medium severity (ESS-003/004, TTE-002, JJS-005, OIT-005, OAP-004) and left for that pass — out of this cluster's scope, which is specifically the JWKS cast at OAuth.ts:248. Status → resolved.
