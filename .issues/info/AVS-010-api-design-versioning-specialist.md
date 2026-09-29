---
ID: "AVS-010"
Title: "Path-parameter naming follows two competing conventions"
Level: info
Category: "api"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuthApi.ts:83"
Auditor: "api-design-versioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AVS-010 — Path-parameter naming follows two competing conventions

`INFO` · `api` · `oauth` · reported by **API Design & Versioning Specialist** (`api-design-versioning-specialist`)

Status: **resolved**

## Summary

Path params are bare nouns in some contracts (`:provider` in oauth, `:id` in passkey's credential routes) and `<entity>Id` in others (`:userId`/`:sessionId` in admin, `:organizationId`/`:invitationId` in organization). The split loosely tracks whether the param is a natural key or a surrogate id, but no rule states that, and generated client parameter names differ accordingly. Low stakes today, but parameter names are part of the derived client API and will be load-bearing at first publish.

## Evidence

Source: `packages/oauth/src/OAuthApi.ts:83`

```
HttpApiEndpoint.get("authorize", "/oauth/:provider/authorize", {
```

## Recommended fix

Adopt one written rule — e.g. surrogate keys always `:singularId`, natural keys always the bare noun — and normalize in the same pre-publish cosmetic sweep as AVS-006.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 63/100), domain: API surface & versioning
- Full dossier: [`api-design-versioning-specialist`](../../.reports/api-design-versioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-005` — RFC 6749 4.1.2.1 authorization error responses are unparseable by the callback contract](medium/AP-005-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`JR-003` — RFC 6749 §4.1.2.1 authorization-error responses are unmodelable: required code param means a user-denial redirect never reaches the uniform typed failure](medium/JR-003-justin-richer.md) `_(justin-richer, medium)_`
- [`OAP-003` — RFC 6749 error responses (error=access_denied, no code) are unmodeled and die as schema-decode failures](medium/OAP-003-oauth2-authorization-code-pkce-specialist.md) `_(oauth2-authorization-code-pkce-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `api-path-param-conventions`. Duplicate of `AVS-006` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuthApi.ts:84`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.
