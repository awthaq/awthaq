---
ID: "AP-005"
Title: "RFC 6749 4.1.2.1 authorization error responses are unparseable by the callback contract"
Level: medium
Category: "compliance"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuthApi.ts:74"
Auditor: "aaron-parecki"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AP-005 — RFC 6749 4.1.2.1 authorization error responses are unparseable by the callback contract

`MEDIUM` · `compliance` · `oauth` · reported by **IETF OAuth Working Group / Creator of IndieAuth** (`aaron-parecki`)

Status: **resolved**

## Summary

RFC 6749 4.1.2.1 mandates that when the user denies consent or the request fails, the provider redirects back with error (plus error_description/error_uri and state) and no code — a normal, expected flow condition, not attacker input. The callback schema makes code and state required strings and does not model the error field at all, so a user clicking "deny" at the provider produces a contract-level query decode failure before the handler ever runs: the application gets an untyped 400 JSON body (a parse error, not the typed OAuthCallbackFailed) and cannot redirect the user anywhere sensible. The plugin header documents typed-JSON-over-redirect as a deliberate convention, but that decision only covers handler failures; the provider-error case never reaches a handler.

## Evidence

Source: `packages/oauth/src/OAuthApi.ts:74`

```
export const CallbackQuery = Schema.Struct({
  code: Schema.String,
  state: Schema.String,
```

## Recommended fix

Extend CallbackQuery with optional error/error_description fields, make code optional, and translate a present error (with matching state) into a typed outcome — e.g. OAuthCallbackFailed carrying the provider error code — so applications can render or redirect consistently.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth2 spec compliance
- Full dossier: [`aaron-parecki`](../../.reports/aaron-parecki/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 6 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AVS-010` — Path-parameter naming follows two competing conventions](info/AVS-010-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, info)_`
- [`JR-003` — RFC 6749 §4.1.2.1 authorization-error responses are unmodelable: required code param means a user-denial redirect never reaches the uniform typed failure](medium/JR-003-justin-richer.md) `_(justin-richer, medium)_`
- [`OAP-003` — RFC 6749 error responses (error=access_denied, no code) are unmodeled and die as schema-decode failures](medium/OAP-003-oauth2-authorization-code-pkce-specialist.md) `_(oauth2-authorization-code-pkce-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-callback-error-contract`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuthApi.ts:74`. Fix: Model RFC 6749 §4.1.2.1 error responses in the callback contract and fold them into the handler's own validated failure path. (effort S). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option B per plan; user may revisit. CallbackQuery: code optional + error/error_description/error_uri; new OAuthAuthorizationDenied { error: Literals(RFC 6749 4.1.2.1 set) } (400) on the callback; OAuth.callback validates cookie+state and consumes the flow first, then (before any exchange) surfaces an enumerated error as the typed denial, an unknown error or a missing code as OAuthCallbackFailed; error_description is logged at debug only and never echoed. Tests (AuthHttp.test.ts, wire-level): error=access_denied with valid state -> {_tag:OAuthAuthorizationDenied,error} (red before: query decode error), unknown code / neither code nor error / mismatched state -> OAuthCallbackFailed, replay after denial fails; BDD scenario 'A user denying consent at the provider gets the typed denial outcome' (REQ-EA-333 tag) + steps. BEH-EA-122 amended. Gates: tsc -b, tsconfig.test.json, vitest 882 pass, test:bdd 106, spec:verify:strict, oxlint.
