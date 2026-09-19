---
ID: "JR-001"
Title: "__Host-oauth-state cookie set with Path=/oauth violates the __Host- prefix rules; browsers drop it and every real-browser OAuth login fails"
Level: high
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:312"
Auditor: "justin-richer"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JR-001 — __Host-oauth-state cookie set with Path=/oauth violates the __Host- prefix rules; browsers drop it and every real-browser OAuth login fails

`HIGH` · `correctness` · `oauth` · reported by **Justin Richer — OAuth2/OIDC Contributor, Co-author of "OAuth 2 in Action"** (`justin-richer`)

Status: **resolved**

## Summary

The correlation cookie is named `__Host-oauth-state` (OAuth.ts:75). Per RFC 6265bis (and uniform Chrome/Firefox/Safari behavior), a __Host- prefixed cookie must be set with Path=/ exactly; a `path: "/oauth"` attribute makes the Set-Cookie invalid and browsers silently discard it. At callback time `request.cookies[OAUTH_STATE_COOKIE]` is therefore always undefined, the binding check at OAuth.ts:529 (`input.cookieState !== input.state`) fails, and every legitimate sign-in returns the uniform 400. This is fail-closed (no vulnerability — the CSRF binding works), but it breaks the plugin's entire happy path in real browsers while remaining invisible to tests: AuthHttp.test.ts:169 only regex-matches the raw Set-Cookie header and the callback test injects the cookie manually (line 222).

## Evidence

Source: `packages/oauth/src/OAuth.ts:312`

```
sameSite: "lax",
          path: "/oauth",
          maxAge: FLOW_TTL,
```

## Recommended fix

Set the cookie with `path: "/"` (keep httpOnly/secure/sameSite/maxAge). Add a test asserting the serialized Set-Cookie header contains `Path=/` for every __Host- prefixed cookie the codebase sets, so the prefix contract is enforced rather than assumed.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth protocol semantics
- Full dossier: [`justin-richer`](../../.reports/justin-richer/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/OAuth.ts:75` names the cookie `__Host-oauth-state`, and lines 308-313 confirm `path: "/oauth"` is set on it (with `httpOnly`, `secure`, `sameSite: "lax"`, `maxAge` also present). Per RFC 6265bis, a `__Host-`-prefixed cookie must be set with `Path=/`, so this Set-Cookie is invalid and browsers discard it; the callback path's binding check (`request.cookies[OAUTH_STATE_COOKIE]`, line 326) then always sees `undefined`. Fail-closed, not a vulnerability, but breaks the real-browser happy path. One-line, unambiguous fix (`path: "/"`). Status → ready-for-agent.

**Resolved (2026-09-19):** `packages/oauth/src/OAuth.ts:312` — dropped the `path: "/oauth"` override on the `__Host-oauth-state` cookie (now `path: "/"`, matching the `__Host-session` convention in `Sessions.ts`). `packages/oauth/test/AuthHttp.test.ts`'s authorize test now asserts the emitted `Set-Cookie` carries `Path=/`, `Secure`, and no `Domain` attribute (TDD: extended first, confirmed red against the old path, then green after the fix). Full `@awthaq/oauth` suite (31 tests) and typecheck pass. Status → resolved.
