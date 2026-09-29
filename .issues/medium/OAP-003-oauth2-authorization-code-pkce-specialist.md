---
ID: "OAP-003"
Title: "RFC 6749 error responses (error=access_denied, no code) are unmodeled and die as schema-decode failures"
Level: medium
Category: "compliance"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuthApi.ts:74"
Auditor: "oauth2-authorization-code-pkce-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OAP-003 — RFC 6749 error responses (error=access_denied, no code) are unmodeled and die as schema-decode failures

`MEDIUM` · `compliance` · `oauth` · reported by **OAuth2 Authorization Code + PKCE Specialist** (`oauth2-authorization-code-pkce-specialist`)

Status: **resolved**

## Summary

CallbackQuery marks code and state as required and defines no error/error_description/error_uri parameters. Per RFC 6749 section 4.1.2.1, when the resource owner denies the request the provider redirects to the callback with error=access_denied and no code parameter; that request now fails query-schema decoding, producing a framework-generated 400 rather than the deliberately indistinguishable typed OAuthCallbackFailed the contract documents (OAuthApi.ts:28-44). The denial branch of the flow is thus outside the plugin's own error model: applications get an opaque decode error and cannot tell 'user denied' from anything else, and the endpoint cannot apply its own uniform-failure policy to the most common non-attack callback outcome.

## Evidence

Source: `packages/oauth/src/OAuthApi.ts:74`

```
export const CallbackQuery = Schema.Struct({
  code: Schema.String,
  state: Schema.String,
```

## Recommended fix

Add optional error/error_description/error_uri fields to CallbackQuery, make code optional at the contract level, and fail the handler with OAuthCallbackFailed whenever an error parameter is present (optionally mapping a controlled denial outcome), keeping the single indistinguishable shape on the wire.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: OAuth2 OIDC flows
- Full dossier: [`oauth2-authorization-code-pkce-specialist`](../../.reports/oauth2-authorization-code-pkce-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 9 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-005` — RFC 6749 4.1.2.1 authorization error responses are unparseable by the callback contract](medium/AP-005-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AVS-010` — Path-parameter naming follows two competing conventions](info/AVS-010-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, info)_`
- [`JR-003` — RFC 6749 §4.1.2.1 authorization-error responses are unmodelable: required code param means a user-denial redirect never reaches the uniform typed failure](medium/JR-003-justin-richer.md) `_(justin-richer, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `oauth-callback-error-contract`. Duplicate of `AP-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuthApi.ts:74`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `AP-005-aaron-parecki` — closed by its fix (see that issue's Resolved comment).
