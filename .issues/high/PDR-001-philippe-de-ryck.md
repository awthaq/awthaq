---
ID: "PDR-001"
Title: "Protocol-relative callbackURL bypasses allowlist and yields post-auth open redirect"
Level: high
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:156"
Auditor: "philippe-de-ryck"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# PDR-001 — Protocol-relative callbackURL bypasses allowlist and yields post-auth open redirect

`HIGH` · `security` · `oauth` · reported by **Philippe De Ryck — Web Application Security Trainer** (`philippe-de-ryck`)

Status: **resolved**

## Summary

resolveCallbackURL trusts any raw value that starts with a single slash as 'same-origin, safe by construction'. That fast path also accepts protocol-relative URLs: callbackURL=//evil.com (or /\evil.com, which browsers normalize) starts with "/", skips the trustedOrigins check entirely, is persisted in the flow payload at authorize time, and at OAuth.ts:335/343 becomes the 302 Location after a successful sign-in. An attacker crafts the authorize link (https://app.example.com/oauth/acme/authorize?callbackURL=//evil.com); the victim completes sign-in at the real provider, receives a legitimate session cookie, then lands on the attacker's origin — a post-authentication open redirect anchored to the trusted app, the exact outcome BEH-EA-128's requirement ('MUST be validated against a trusted-origin allowlist before the redirect is issued') is written to prevent. No code, state, or token rides the redirect (redirect_uri is pinned to baseUrl), so this is phishing positioning, not direct token theft, but it defeats the spec's control.

## Evidence

Source: `packages/oauth/src/OAuth.ts:156`

```
if (raw === undefined) return fallback;
  if (raw.startsWith("/")) return raw;
  const parsed = Option.fromNullOr(URL.parse(raw));
```

## Recommended fix

Treat a leading-slash value as same-origin only when it is genuinely path-relative: reject raw values whose second character is also "/" or "\\", or better, normalize by parsing new URL(raw, config_.baseUrl) and requiring url.origin === new URL(config_.baseUrl).origin before honoring it; keep the allowlist check as the only other acceptance branch.

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

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/OAuth.ts:150-162`'s `resolveCallbackURL` matches the evidence exactly; `raw.startsWith("/")` at line 156 accepts a protocol-relative `//evil.com` before the trusted-origin allowlist check ever runs, and the returned value is later handed straight to `HttpServerResponse.redirect` (lines 335/343). Fix is a well-scoped, mechanical origin-parsing change. Status → ready-for-agent.

**Resolved (2026-09-19):** Same fix as `OAP-001` (shared source line, identical vulnerability and recommended fix) — see that finding's comment.
