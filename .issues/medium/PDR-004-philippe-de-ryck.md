---
ID: "PDR-004"
Title: "No security headers anywhere: no Referrer-Policy on auth redirects, no HSTS, no CSP, no X-Content-Type-Options"
Level: medium
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:335"
Auditor: "philippe-de-ryck"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# PDR-004 — No security headers anywhere: no Referrer-Policy on auth redirects, no HSTS, no CSP, no X-Content-Type-Options

`MEDIUM` · `security` · `oauth` · reported by **Philippe De Ryck — Web Application Security Trainer** (`philippe-de-ryck`)

Status: **resolved**

## Summary

Zero matches for Content-Security-Policy, Strict-Transport-Security, Referrer-Policy, X-Frame-Options, or X-Content-Type-Options across all 21 packages — the runtime emits responses (including the post-auth 302 above and every Set-Cookie) with no hardening seam at all. For an auth runtime this matters concretely: without Referrer-Policy: no-referrer, browser default referrer policies still leak full URLs of app pages (including any state or callbackURL query remnants) in Referer headers to third-party subresources on those pages; without an HSTS story, the Secure cookie attributes assume TLS is enforced at the edge. Header policy is legitimately an app/deployment concern for a library, but the repo neither sets nor documents it, and the auth redirect handler is the one place the library itself owns the response end to end.

## Evidence

Source: `packages/oauth/src/OAuth.ts:335`

```
const response = HttpServerResponse.redirect(outcome.callbackURL);
          return yield* HttpServerResponse.setCookie(
```

## Recommended fix

Add Referrer-Policy: no-referrer (or strict-origin-when-cross-origin) to the OAuth authorize/callback redirect responses in OAuthHandlers, and provide a small opt-in security-headers middleware in @awthaq/server plus a deployment checklist entry covering HSTS/CSP so the responsibility is explicit rather than implicit.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: Web attack surface
- Full dossier: [`philippe-de-ryck`](../../.reports/philippe-de-ryck/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-callback-http-hardening`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:431`. Fix: Set `Referrer-Policy: no-referrer` on the OAuth authorize and callback responses, and ship an opt-in security-headers middleware plus a deployment checklist. (effort M). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** OAuth authorize and callback register a pre-response handler setting Referrer-Policy: no-referrer, so it covers 302s and framework-encoded 400/503 bodies (AuthHttp.test.ts 'PDR-004' red before: header absent; mutation-checked). New opt-in @awthaq/server SecurityHeaders.layer(options) (global HttpRouter middleware: HSTS, nosniff, Referrer-Policy, X-Frame-Options DENY, CSP frame-ancestors 'none'; each overridable or false; never overrides a handler-set header) with test/SecurityHeaders.test.ts (defaults, override/omit, no-clobber) and a Deployment checklist section appended to packages/server/README.md. BEH-EA-122 amended. Files outside packages/oauth: packages/server/src/{SecurityHeaders,index}.ts, packages/server/README.md. Gates as CSS-004.
