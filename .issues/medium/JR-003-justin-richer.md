---
ID: "JR-003"
Title: "RFC 6749 §4.1.2.1 authorization-error responses are unmodelable: required code param means a user-denial redirect never reaches the uniform typed failure"
Level: medium
Category: "compliance"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuthApi.ts:74"
Auditor: "justin-richer"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JR-003 — RFC 6749 §4.1.2.1 authorization-error responses are unmodelable: required code param means a user-denial redirect never reaches the uniform typed failure

`MEDIUM` · `compliance` · `oauth` · reported by **Justin Richer — OAuth2/OIDC Contributor, Co-author of "OAuth 2 in Action"** (`justin-richer`)

Status: **resolved**

## Summary

When the end user denies consent, the provider redirects to the callback with `error=access_denied` and no `code` (RFC 6749 §4.1.2.1); it may also send `error_description`/`error_uri`. CallbackQuery requires `code` and has no error fields, so the denial request fails contract decoding at the framework layer with a decode-shaped 400 — precisely the non-uniform, framework-detailed failure the OAuthCallbackFailed design (OAuthApi.ts:28-38: 'which specific stage failed is exactly what an attacker probing the callback endpoint should not be able to learn') exists to prevent. RFC 6749 also requires the client to validate state on error responses, which is structurally impossible here. A repo-wide grep finds zero occurrences of access_denied/error_description/error_uri/invalid_grant in packages/ or features/.

## Evidence

Source: `packages/oauth/src/OAuthApi.ts:74`

```
export const CallbackQuery = Schema.Struct({
  code: Schema.String,
  state: Schema.String,
```

## Recommended fix

Make `code` optional and add optional `error`/`error_description` fields to CallbackQuery; in the handler, treat any request carrying an `error` param (or missing code) as the same OAuthCallbackFailed after validating state/cookie, preserving the uniform-failure property across the denial path.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth protocol semantics
- Full dossier: [`justin-richer`](../../.reports/justin-richer/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-005` — RFC 6749 4.1.2.1 authorization error responses are unparseable by the callback contract](medium/AP-005-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AVS-010` — Path-parameter naming follows two competing conventions](info/AVS-010-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, info)_`
- [`OAP-003` — RFC 6749 error responses (error=access_denied, no code) are unmodeled and die as schema-decode failures](medium/OAP-003-oauth2-authorization-code-pkce-specialist.md) `_(oauth2-authorization-code-pkce-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `oauth-callback-error-contract`. Duplicate of `AP-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuthApi.ts:74`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `AP-005-aaron-parecki` — closed by its fix (see that issue's Resolved comment).
