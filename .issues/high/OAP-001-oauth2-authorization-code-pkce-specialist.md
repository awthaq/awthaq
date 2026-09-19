---
ID: "OAP-001"
Title: "Network-path reference callbackURL (//host, /\\host) bypasses trusted-origin allowlist: post-login open redirect"
Level: high
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:156"
Auditor: "oauth2-authorization-code-pkce-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OAP-001 — Network-path reference callbackURL (//host, /\host) bypasses trusted-origin allowlist: post-login open redirect

`HIGH` · `security` · `oauth` · reported by **OAuth2 Authorization Code + PKCE Specialist** (`oauth2-authorization-code-pkce-specialist`)

Status: **resolved**

## Summary

resolveCallbackURL accepts any string beginning with '/' as a safe same-origin destination, but a network-path reference such as '//evil.com/phish' or '/\evil.com/phish' also starts with '/' and the browser resolves it against the current scheme, navigating off-origin. The value is attacker-controlled via the authorize query (query.callbackURL at OAuth.ts:304), is persisted into the flow payload, and is finally used in HttpServerResponse.redirect(outcome.callbackURL) at OAuth.ts:335/343 after authentication succeeds. This is exactly the CVE-2026-82274 class of post-auth open redirect that spec BEH-EA-128 forbids ('MUST be validated against a trusted-origin allowlist'), and the existing test only covers a relative '/dashboard' and absolute URLs, so the bypass is untested. Impact: phishing redirect of freshly signed-in users; no token leak since the session cookie is host-scoped.

## Evidence

Source: `packages/oauth/src/OAuth.ts:156`

```
  if (raw === undefined) return fallback;
  if (raw.startsWith("/")) return raw;
```

## Recommended fix

Treat a raw callbackURL as relative only when it matches /^\/[^/\\]/ (single leading slash followed by neither slash nor backslash); otherwise require URL.parse success and an exact origin match against trustedOrigins. Add regression tests for '//evil.com' and '/\evil.com'.

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

**Validation (2026-09-19):** CONFIRMED — `resolveCallbackURL` at `packages/oauth/src/OAuth.ts:156` still does `if (raw.startsWith("/")) return raw;` with no rejection of network-path references, so `//evil.com/phish` and `/\evil.com/phish` both pass through unchanged and reach `HttpServerResponse.redirect(outcome.callbackURL)` at `packages/oauth/src/OAuth.ts:335` and `:343`. `packages/oauth/test/OAuth.test.ts` only exercises a plain relative path (`/settings`, line 760) and absolute allowlisted/non-allowlisted URLs (lines 700-742); no test covers a protocol-relative or backslash variant. The recommended fix (tighten the relative-path check to `/^\/[^/\\]/`) is a small, well-scoped change to one function plus new tests. Status → ready-for-agent.

**Resolved (2026-09-19):** `resolveCallbackURL` (`packages/oauth/src/OAuth.ts`) now only treats `raw` as a safe same-origin relative path when it starts with `/` and its second character is neither `/` nor `\` — closing both the scheme-relative (`//evil.com/phish`) and backslash-variant (`/\evil.com/phish`) bypasses a browser still resolves off-origin. Everything else falls through to the existing `URL.parse` + `trustedOrigins` allowlist check unchanged, and a bare `"/"` is still honored (verified with a dedicated regression test). Two new regression tests in `packages/oauth/test/OAuth.test.ts` assert both bypass forms resolve to the safe fallback `"/"` — verified to genuinely fail (each echoing the attacker URL unchanged) with the fix reverted. Full monorepo typecheck and test suite (609 tests) pass.
