---
ID: "OAP-002"
Title: "__Host-oauth-state cookie set with path=/oauth violates the __Host- prefix rules; browsers reject it and every browser flow fails"
Level: high
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:312"
Auditor: "oauth2-authorization-code-pkce-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OAP-002 — __Host-oauth-state cookie set with path=/oauth violates the __Host- prefix rules; browsers reject it and every browser flow fails

`HIGH` · `correctness` · `oauth` · reported by **OAuth2 Authorization Code + PKCE Specialist** (`oauth2-authorization-code-pkce-specialist`)

Status: **resolved**

## Summary

The constant OAUTH_STATE_COOKIE (OAuth.ts:75) uses the __Host- prefix, but the Set-Cookie at OAuth.ts:308-314 scopes it with path: "/oauth". RFC 6265bis section 4.1.3 requires a __Host- cookie to be Secure, Domain-less, and have Path exactly /; Chrome, Firefox, and Safari all reject the cookie otherwise. The correlation cookie is therefore never stored by a real browser, cookieState is undefined at callback (OAuth.ts:326-331), and the state/cookie equality check at OAuth.ts:529 fails for 100% of browser-driven flows - fail-closed, but the plugin is unusable in its primary deployment. Tests cannot catch this: AuthHttp.test.ts:169 only asserts the raw Set-Cookie header matches /^__Host-oauth-state=/, and no browser smoke test exists. Note the sibling session cookie (Sessions.ts:124-129) correctly uses path: "/" with the same __Host- prefix, showing the intended convention was violated here.

## Evidence

Source: `packages/oauth/src/OAuth.ts:312`

```
          secure: true,
          sameSite: "lax",
          path: "/oauth",
```

## Recommended fix

Set the state cookie with path: "/" to satisfy the __Host- prefix contract (mirroring SESSION_COOKIE_ATTRIBUTES), or if path scoping is intentional, drop the prefix to a non-reserved name such as oauth-state. Add a wire-level assertion that the cookie attributes satisfy the prefix rules.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: OAuth2 OIDC flows
- Full dossier: [`oauth2-authorization-code-pkce-specialist`](../../.reports/oauth2-authorization-code-pkce-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 9 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `OAUTH_STATE_COOKIE` (`packages/oauth/src/OAuth.ts:75`) is `"__Host-oauth-state"` and the `setCookie` call at `packages/oauth/src/OAuth.ts:308-314` still sets `path: "/oauth"`, which violates the `__Host-` prefix's Path=`/` requirement. By contrast `packages/core/src/Sessions.ts:123-128` defines `SESSION_COOKIE_NAME = "__Host-session"` with `SESSION_COOKIE_ATTRIBUTES` using `path: "/"`, confirming the sibling cookie follows the correct convention. `packages/oauth/test/AuthHttp.test.ts:169` only asserts `/^__Host-oauth-state=/` against the raw header and never checks the `Path` attribute, so a real-browser rejection would go undetected. The fix (change `path: "/oauth"` to `path: "/"`, mirroring `SESSION_COOKIE_ATTRIBUTES`) is a one-line, well-scoped change. Status → ready-for-agent.

**Resolved (2026-09-19):** `packages/oauth/src/OAuth.ts:312` — dropped the `path: "/oauth"` override on the `__Host-oauth-state` cookie (now `path: "/"`, matching the `__Host-session` convention in `Sessions.ts`). `packages/oauth/test/AuthHttp.test.ts`'s authorize test now asserts the emitted `Set-Cookie` carries `Path=/`, `Secure`, and no `Domain` attribute (TDD: extended first, confirmed red against the old path, then green after the fix). Full `@awthaq/oauth` suite (31 tests) and typecheck pass. Status → resolved.
