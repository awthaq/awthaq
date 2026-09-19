---
ID: "CDS-002"
Title: "__Host-oauth-state cookie set with path=/oauth violates the __Host- prefix, so the login-CSRF correlation defense never engages in a real browser"
Level: high
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:312"
Auditor: "csrf-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CDS-002 — __Host-oauth-state cookie set with path=/oauth violates the __Host- prefix, so the login-CSRF correlation defense never engages in a real browser

`HIGH` · `security` · `oauth` · reported by **CSRF Defense Specialist** (`csrf-defense-specialist`)

Status: **resolved**

## Summary

OAUTH_STATE_COOKIE is "__Host-oauth-state" (OAuth.ts:75), and the __Host- prefix (RFC 6265bis) requires Secure, no Domain, and Path=/. Setting path=/oauth makes the cookie unacceptable to conforming browsers, so it is silently dropped: at callback time request.cookies[OAUTH_STATE_COOKIE] is undefined (OAuth.ts:326) and the correlation check `input.cookieState !== input.state` (OAuth.ts:529) fails unconditionally. The BEH-EA-122 login-CSRF/code-injection defense is therefore inert — and worse, the entire OAuth sign-in flow fails for real browser users (fail-closed, so not directly exploitable, but the shipped defense and the shipped feature are both dead). The test suite cannot catch this because it hand-crafts the Cookie header on a plain Request (packages/oauth/test/AuthHttp.test.ts:221-222) instead of asserting on the emitted Set-Cookie attributes.

## Evidence

Source: `packages/oauth/src/OAuth.ts:312`

```
secure: true,
sameSite: "lax",
path: "/oauth",
```

## Recommended fix

Drop the path attribute (default Path=/) from the setCookie call at OAuth.ts:312 so the __Host- cookie is valid; add a Set-Cookie format test asserting every __Host-prefixed cookie the library emits carries Path=/ and no Domain attribute, and run one OAuth round trip against a real fetch client rather than synthetic Request objects.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: CSRF defense
- Full dossier: [`csrf-defense-specialist`](../../.reports/csrf-defense-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/OAuth.ts:75` defines `OAUTH_STATE_COOKIE = "__Host-oauth-state"`, and the `setCookie` call at lines 308-314 passes `path: "/oauth"` explicitly, which violates the `__Host-` prefix's Path=/ requirement (RFC 6265bis), so conforming browsers drop the cookie. The callback reads it at line 326 and the correlation check `input.cookieState !== input.state` at line 529 would then always fail. `packages/oauth/test/AuthHttp.test.ts:221-222` hand-sets the `cookie` header directly on a `Request`, bypassing real Set-Cookie parsing, so this would not be caught by the existing test. Fix is a one-line mechanical removal of the `path` attribute. Status → ready-for-agent.

**Resolved (2026-09-19):** `packages/oauth/src/OAuth.ts:312` — dropped the `path: "/oauth"` override on the `__Host-oauth-state` cookie (now `path: "/"`, matching the `__Host-session` convention in `Sessions.ts`). `packages/oauth/test/AuthHttp.test.ts`'s authorize test now asserts the emitted `Set-Cookie` carries `Path=/`, `Secure`, and no `Domain` attribute (TDD: extended first, confirmed red against the old path, then green after the fix). Full `@awthaq/oauth` suite (31 tests) and typecheck pass. Status → resolved.
