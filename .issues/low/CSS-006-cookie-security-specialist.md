---
ID: "CSS-006"
Title: "Consumed __Host-oauth-state cookie is never expired at the callback"
Level: low
Category: "security"
Status: ready-for-agent
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:336"
Auditor: "cookie-security-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSS-006 — Consumed __Host-oauth-state cookie is never expired at the callback

`LOW` · `security` · `oauth` · reported by **Cookie Security Specialist** (`cookie-security-specialist`)

Status: **ready-for-agent**

## Summary

The callback responds with a redirect and (on success) the session cookie, but never expires the correlation cookie — there is no maxAge-0 write anywhere in the flow, so a used state cookie would linger for its full FLOW_TTL of 10 minutes (OAuth.ts:76). Server-side single-use Verification consumption (OAuth.ts:529 onward) makes replay of a used state harmless, so this is defense-in-depth rather than a hole; it is also currently masked by CSS-001 (conforming browsers never store the cookie at all). Standard practice for single-use correlation cookies is to clear them on the response that consumes them.

## Evidence

Source: `packages/oauth/src/OAuth.ts:336`

```
if (outcome.session !== undefined) {
          const response = HttpServerResponse.redirect(outcome.callbackURL);
          return yield* HttpServerResponse.setCookie(
```

## Recommended fix

On both callback outcomes (success and OAuthCallbackFailed), append a Set-Cookie expiring OAUTH_STATE_COOKIE (same attributes, maxAge 0), and assert it in the wire test.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 58/100), domain: Cookie & Set-Cookie security
- Full dossier: [`cookie-security-specialist`](../../.reports/cookie-security-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-callback-http-hardening`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:431`. Fix: Expire __Host-oauth-state on every callback response: success, link, and typed failure. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.
