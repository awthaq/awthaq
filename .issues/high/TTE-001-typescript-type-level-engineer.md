---
ID: "TTE-001"
Title: "Remote JWKS response laundered through `as unknown as Jwt.Jwks` and cached without validation"
Level: high
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:248"
Auditor: "typescript-type-level-engineer"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TTE-001 — Remote JWKS response laundered through `as unknown as Jwt.Jwks` and cached without validation

`HIGH` · `correctness` · `oauth` · reported by **TypeScript Type-Level Engineer** (`typescript-type-level-engineer`)

Status: **resolved**

## Summary

The one `as unknown as` in library source sits at the worst possible spot: an attacker-influenced remote IdP response is asserted to `Jwt.Jwks` with no runtime check, then cached in a Ref. A malformed body (missing `keys`, non-object, array) flows forward fully typed; downstream `findKey` then fails as a defect-shaped KeyError rather than a typed OAuthCallbackFailed, and the double assertion is precisely the pattern this repo's own rule forbids (`packages/password/src/Password.ts:133`: "this repo forbids `as`/`as unknown as`/`as any` in library source").

## Evidence

Source: `packages/oauth/src/OAuth.ts:248`

```
Effect.flatMap((response) => response.json),
Effect.map((body) => body as unknown as Jwt.Jwks),
Effect.tap((jwks) => Ref.update(jwksCache, (cache) => HashMap.set(cache, provider.id, jwks))),
```

## Recommended fix

Validate the response with a Schema (`Schema.Struct({ keys: Schema.Array(JwkSchema) })` via `Schema.decodeUnknown`) and map decode failures to the already-existing `OAuthApi.OAuthCallbackFailed` channel; the assertion then disappears because the type is earned, not declared.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Type-Level Rigor
- Full dossier: [`typescript-type-level-engineer`](../../.reports/typescript-type-level-engineer/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/OAuth.ts:248-249` matches the evidence exactly; repo-wide grep confirms this is the only ` as unknown as ` (or `as any`) in any package's `src`. `OAuthApi.OAuthCallbackFailed` already exists as the target error channel. Mechanical fix (Schema-validate and map to the existing error). Status → ready-for-agent.

**Resolved (2026-09-19):** `packages/oauth/src/Jwt.ts` now exports `JwksDocumentSchema` (`{ keys: Array(Record(String, Unknown)) }`, mirroring `packages/jwt/src/verify.ts`'s own established idiom for the identical shape); `OAuth.ts:246` decodes the fetched JWKS body via `HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema)` instead of `response.json` + `as unknown as Jwt.Jwks`, with a decode failure now mapped to the same typed `OAuthCallbackFailed` every other check in `verifyIdToken` already uses. `findKey`/`verifyRs256` updated to work off the schema-derived `Record<string, unknown>` entries. Added a regression test (a malformed `{ keys: "not-an-array" }` JWKS response, previously would have laundered through the cast into a defect-shaped crash in `findKey`, now fails typed as `OAuthCallbackFailed`) — TDD: confirmed the new test passes against the fix, full `@awthaq/oauth` suite (32 tests) and monorepo typecheck pass. Note: the sibling casts GC-001 also mentions (`OAuth.ts:211`'s token-response body, `Jwt.ts`'s id_token header/payload) are separately tracked at medium severity (ESS-003/004, TTE-002, JJS-005, OIT-005, OAP-004) and left for that pass — out of this cluster's scope, which is specifically the JWKS cast at OAuth.ts:248. Status → resolved.
