---
ID: "SFS-002"
Title: "Untrusted-body cast in the federation seam a SAML plugin would be modeled on"
Level: high
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:248"
Auditor: "saml-federation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SFS-002 — Untrusted-body cast in the federation seam a SAML plugin would be modeled on

`HIGH` · `security` · `oauth` · reported by **SAML Federation Specialist** (`saml-federation-specialist`)

Status: **resolved**

## Summary

The only existing handling of an untrusted federation response body is a type assertion instead of a schema decode, for a JWKS document fetched over HTTP. packages/jwt/src/verify.ts:14-19 explicitly names this exact spot as this codebase's anti-pattern ("that file predates this convention and isn't the pattern to copy") in favor of Schema.decodeUnknownEffect. A future SAML plugin will be written by analogy to this callback path, and its input is XML where a cast-equivalent (parse without entity resolution, verify without checking the signed element is the processed one) is the classic XXE and signature-wrapping catastrophe. The seam that SAML extends currently models the wrong habit.

## Evidence

Source: `packages/oauth/src/OAuth.ts:248`

```
Effect.map((body) => body as unknown as Jwt.Jwks),
```

## Recommended fix

Decode the JWKS body through Schema before it enters the trust path (matching jwt/verify.ts), and when designing the SamlSigner port make parsing plus signature verification one typed operation so no raw XML or cast can leak above the port.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: SAML Federation
- Full dossier: [`saml-federation-specialist`](../../.reports/saml-federation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — OAuth.ts:248 `body as unknown as Jwt.Jwks` matches verbatim, and packages/jwt/src/verify.ts:14-19's header comment explicitly names this exact line as the anti-pattern it deliberately avoids via `Schema.decodeUnknownEffect`. Swapping the cast for a schema decode following that established pattern is a well-scoped, mechanical fix. Status → ready-for-agent.

**Resolved (2026-09-19):** `packages/oauth/src/Jwt.ts` now exports `JwksDocumentSchema` (`{ keys: Array(Record(String, Unknown)) }`, mirroring `packages/jwt/src/verify.ts`'s own established idiom for the identical shape); `OAuth.ts:246` decodes the fetched JWKS body via `HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema)` instead of `response.json` + `as unknown as Jwt.Jwks`, with a decode failure now mapped to the same typed `OAuthCallbackFailed` every other check in `verifyIdToken` already uses. `findKey`/`verifyRs256` updated to work off the schema-derived `Record<string, unknown>` entries. Added a regression test (a malformed `{ keys: "not-an-array" }` JWKS response, previously would have laundered through the cast into a defect-shaped crash in `findKey`, now fails typed as `OAuthCallbackFailed`) — TDD: confirmed the new test passes against the fix, full `@awthaq/oauth` suite (32 tests) and monorepo typecheck pass. Note: the sibling casts GC-001 also mentions (`OAuth.ts:211`'s token-response body, `Jwt.ts`'s id_token header/payload) are separately tracked at medium severity (ESS-003/004, TTE-002, JJS-005, OIT-005, OAP-004) and left for that pass — out of this cluster's scope, which is specifically the JWKS cast at OAuth.ts:248. Status → resolved.
