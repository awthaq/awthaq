---
ID: "MNA-004"
Title: "Callback URL allowlist cannot admit custom-scheme deep links and fails silently"
Level: high
Category: "dx"
Status: ready-for-agent
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:159"
Auditor: "mobile-native-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MNA-004 — Callback URL allowlist cannot admit custom-scheme deep links and fails silently

`HIGH` · `dx` · `oauth` · reported by **Mobile/Native Auth Specialist** (`mobile-native-auth-specialist`)

Status: **ready-for-agent**

## Summary

resolveCallbackURL admits only relative paths or absolute URLs whose URL origin is on trustedOrigins. Per the WHATWG URL spec, non-special schemes such as myapp:// have an opaque origin serialized as "null", so a custom-scheme deep link can never match an https allowlist entry and is silently replaced by defaultCallbackURL (REQ-EA-353's deliberate no-error posture). A mobile developer configuring myapp://callback gets redirected to the web default with no diagnostic; universal links (https origins) are the only deep-link shape that can pass, and nothing in the docs says so.

## Evidence

Source: `packages/oauth/src/OAuth.ts:159`

```
  const parsed = Option.fromNullOr(URL.parse(raw));
  return parsed.pipe(
    Option.filter((url) => trustedOrigins.includes(url.origin)),
```

## Recommended fix

Match non-http(s) callback URLs on the full serialized URL (scheme + host) against a separate deep-link allowlist, and emit a typed error or at least a logged warning when a requested callbackURL is discarded instead of silently falling back.

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

**Validation (2026-09-19):** CONFIRMED — `OAuth.ts:150-162` (evidence at lines 157-159) matches: `resolveCallbackURL` filters on `url.origin` membership in `trustedOrigins`, and the code comment at 143-148 confirms the documented no-error fallback (REQ-EA-353). Per WHATWG URL, a non-special scheme like `myapp://` serializes its origin as `"null"`, so it can never match an `https://...` allowlist entry and silently falls back to `defaultCallbackURL` with no log or error. The fix (match non-http(s) URLs by full scheme+host against a separate deep-link allowlist, plus a warning log) is well-scoped and mechanical. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `native-session-bootstrap`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:180`. Fix: Add an explicit native-redirect allowlist matched on the full serialized scheme+authority(+path prefix) for non-http(s) URLs, and log when a requested callbackURL is discarded. (effort M). Full dossier: `.plan/slices/03-oauth-flow.md`.
