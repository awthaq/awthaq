---
ID: "MNA-002"
Title: "__Host-oauth-state cookie set with path /oauth violates the __Host- prefix and is dropped by browsers"
Level: high
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:312"
Auditor: "mobile-native-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MNA-002 — __Host-oauth-state cookie set with path /oauth violates the __Host- prefix and is dropped by browsers

`HIGH` · `correctness` · `oauth` · reported by **Mobile/Native Auth Specialist** (`mobile-native-auth-specialist`)

Status: **resolved**

## Summary

OAUTH_STATE_COOKIE is named "__Host-oauth-state" (OAuth.ts:75) but is set with path "/oauth". The __Host- prefix requires Secure, no Domain, and Path exactly "/"; Chrome, Safari, and Firefox reject any Set-Cookie that violates it (MDN Set-Cookie docs; RFC 6265bis cookie prefixes). A real browser therefore never stores the state cookie, so callback's binding check (input.cookieState !== input.state, OAuth.ts:529) fails on every request and OAuth sign-in 400s universally outside the in-memory test harness. Any native flow riding ASWebAuthenticationSession/Custom Tabs fails identically. The tests pass only because the platform cookie store does not enforce prefixes.

## Evidence

Source: `packages/oauth/src/OAuth.ts:312`

```
          sameSite: "lax",
          path: "/oauth",
          maxAge: FLOW_TTL,
```

## Recommended fix

Set path "/" for the state cookie (the /oauth scoping buys nothing security-wise), or rename the cookie without the __Host- prefix if path scoping is truly wanted.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: mobile client readiness
- Full dossier: [`mobile-native-auth-specialist`](../../.reports/mobile-native-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Validation (2026-09-19):** CONFIRMED — `OAuth.ts:75` names the cookie `"__Host-oauth-state"` and `OAuth.ts:308-314` (evidence at line 312) sets it with `path: "/oauth"`, `secure: true`, no `domain`. Per RFC 6265bis, a `__Host-` prefixed cookie is rejected by conforming user agents unless `Path=/`; browsers enforcing the prefix would silently drop this cookie, making the callback's state-binding check at `OAuth.ts:326` fail on every real request. Fix is a one-line, well-scoped mechanical change (path "/" or drop the prefix). Status → ready-for-agent.

**Resolved (2026-09-19):** `packages/oauth/src/OAuth.ts:312` — dropped the `path: "/oauth"` override on the `__Host-oauth-state` cookie (now `path: "/"`, matching the `__Host-session` convention in `Sessions.ts`). `packages/oauth/test/AuthHttp.test.ts`'s authorize test now asserts the emitted `Set-Cookie` carries `Path=/`, `Secure`, and no `Domain` attribute (TDD: extended first, confirmed red against the old path, then green after the fix). Full `@awthaq/oauth` suite (31 tests) and typecheck pass. Status → resolved.
