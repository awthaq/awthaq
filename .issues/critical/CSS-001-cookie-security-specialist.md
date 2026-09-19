---
ID: "CSS-001"
Title: "__Host-oauth-state cookie set with path=/oauth — voids the __Host- prefix, so real browsers drop it and every OAuth sign-in fails"
Level: critical
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:312"
Auditor: "cookie-security-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSS-001 — __Host-oauth-state cookie set with path=/oauth — voids the __Host- prefix, so real browsers drop it and every OAuth sign-in fails

`CRITICAL` · `security` · `oauth` · reported by **Cookie Security Specialist** (`cookie-security-specialist`)

Status: **resolved**

## Summary

The state cookie's name is "__Host-oauth-state" (OAuth.ts:75). RFC 6265bis cookie-name prefixes require a __Host- cookie to be Secure, carry no Domain, and have Path=/ exactly; Chrome/Firefox/Safari reject the Set-Cookie otherwise. With path:"/oauth" the authorize redirect's cookie is silently discarded by any conforming browser, so callback reads request.cookies[OAUTH_STATE_COOKIE] as undefined (OAuth.ts:326) and the correlation check input.cookieState !== input.state (OAuth.ts:529) fails on every legitimate login — the whole browser OAuth flow is dead, and the BEH-EA-122 login-CSRF/code-injection defense never actually enforces anything in production. Note it also bypasses HttpApiBuilder.securitySetCookie (which defaults secure:true) by calling HttpServerResponse.setCookie directly. The sibling __Host-session cookie proves the codebase knows the convention: Sessions.ts:128 uses path:"/".

## Evidence

Source: `packages/oauth/src/OAuth.ts:312`

```
secure: true,
          sameSite: "lax",
          path: "/oauth",
```

## Recommended fix

Set the state cookie with path:"/" (drop the path override, or reuse a shared constant), and add a wire-level assertion that the Set-Cookie attributes satisfy the prefix rules (Secure, Path=/, no Domain) — the existing test only matches the name.

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

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/OAuth.ts:308-314` sets the `__Host-oauth-state` cookie with `secure: true, sameSite: "lax", path: "/oauth"`, exactly matching the evidence; `path: "/oauth"` (not `/`) does violate the `__Host-` prefix rule, so conforming browsers drop the cookie. The sibling `__Host-session` cookie (`packages/core/src/Sessions.ts:124-129`) correctly uses `path: "/"`, confirming the codebase knows the convention. Status → ready-for-agent.

**Resolved (2026-09-19):** `packages/oauth/src/OAuth.ts:312` — dropped the `path: "/oauth"` override on the `__Host-oauth-state` cookie (now `path: "/"`, matching the `__Host-session` convention in `Sessions.ts`). `packages/oauth/test/AuthHttp.test.ts`'s authorize test now asserts the emitted `Set-Cookie` carries `Path=/`, `Secure`, and no `Domain` attribute (TDD: extended first, confirmed red against the old path, then green after the fix). Full `@awthaq/oauth` suite (31 tests) and typecheck pass. Status → resolved.
