---
ID: "ESS-003"
Title: "Token-exchange response cast; id_token type never validated"
Level: medium
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:211"
Auditor: "effect-schema-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-003 — Token-exchange response cast; id_token type never validated

`MEDIUM` · `correctness` · `oauth` · reported by **Effect Schema Specialist** (`effect-schema-specialist`)

Status: **resolved**

## Summary

The token endpoint's response is cast to `{ access_token?: string; id_token?: string }` and only access_token is narrowed with a runtime typeof check (line 215); body.id_token is returned as-is, so a provider replying with a numeric or object id_token flows into verifyIdToken. The failure is caught downstream (Jwt.decode's Effect.try), but the boundary itself validates one of its two fields and trusts the other by assertion.

## Evidence

Source: `packages/oauth/src/OAuth.ts:211`

```
const body = (yield* response.json) as {
  readonly access_token?: string;
  readonly id_token?: string;
};
```

## Recommended fix

Decode the response with Schema.Struct({ access_token: Schema.optional(Schema.String), id_token: Schema.optional(Schema.String) }) via Schema.decodeUnknownEffect and fail OAuthCallbackFailed on decode error, dropping the manual typeof.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-provider-response-decoding`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:250`. Fix: Decode token-endpoint and userinfo responses with Schema at the boundary, shared by OAuth.ts and OAuthTokenAccess.ts, and delete the casts. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** New packages/oauth/src/ProviderResponses.ts (TokenResponseSchema with expires_in number|NumberFromString, UserinfoSchema) shared by OAuth.exchangeCode, the userinfo call and OAuthTokenAccess.refresh via HttpIncomingMessage.schemaBodyJson; all response casts deleted (also the FlowPayload guard -> FlowPayloadSchema decode, tuple 'as const' in the registry/rate-limit, Jwt.decode's tuple cast). Tests: expires_in numeric string (red: expiry was dropped) plus pins for numeric id_token, array token body, array userinfo body, refresh non-string access_token. Gates: tsc -b + tsconfig.test.json, vitest 837 pass, test:bdd, spec:verify:strict, oxlint packages/oauth.
