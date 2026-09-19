---
ID: "AP-001"
Title: "Scheme-relative //host callbackURL bypasses the trusted-origin allowlist (open redirect)"
Level: high
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:156"
Auditor: "aaron-parecki"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AP-001 — Scheme-relative //host callbackURL bypasses the trusted-origin allowlist (open redirect)

`HIGH` · `security` · `oauth` · reported by **IETF OAuth Working Group / Creator of IndieAuth** (`aaron-parecki`)

Status: **resolved**

## Summary

resolveCallbackURL treats any input starting with "/" as same-origin-safe and returns it unparsed. A protocol-relative value such as "//evil.com/path" (or "/\\evil.com", which browsers normalize) starts with "/" yet resolves cross-origin in every browser, so HttpServerResponse.redirect at OAuth.ts:335/343 sends the freshly authenticated user to an attacker-controlled origin. This is precisely the attack class BEH-EA-128 was written to prevent (spec/behaviors/16-oauth.md cites CVE-2026-82274 and RFC 9700's "no open redirectors" rule), and the test suite only covers the single-slash form "/settings", so the bypass is untested. The success case also sets the new session cookie on the response being redirected, making the redirect target a phishing/referrer-leak hot spot.

## Evidence

Source: `packages/oauth/src/OAuth.ts:156`

```
if (raw === undefined) return fallback;
  if (raw.startsWith("/")) return raw;
  const parsed = Option.fromNullOr(URL.parse(raw));
```

## Recommended fix

Resolve every candidate against the configured origin: const url = new URL(raw, config_.baseUrl), then require url.origin === new URL(config_.baseUrl).origin OR membership in trustedOrigins; reject anything else to fallback. Add a regression test for "//attacker.example.com" and "/\\attacker.example.com".

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth2 spec compliance
- Full dossier: [`aaron-parecki`](../../.reports/aaron-parecki/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 6 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-003` — id_token aud accepted only as an exact string; array-form audiences rejected](medium/AP-003-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-004` — Userinfo claims merged over id_token claims without the required sub equality check](medium/AP-004-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-006` — Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored](medium/AP-006-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-008` — Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires](low/AP-008-aaron-parecki.md) `_(aaron-parecki, low)_`
- [`AH-002` — JWKS response cast wholesale with as unknown as and cached unvalidated](medium/AH-002-anders-hejlsberg.md) `_(anders-hejlsberg, medium)_`
- [`AGA-001` — OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer](high/AGA-001-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, high)_`
- [`AGA-005` — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL](low/AGA-005-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, low)_`
- [`ACS-004` — JWKS response cast unvalidated before becoming key material](medium/ACS-004-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, medium)_`
- … 65 more findings touch `packages/oauth/src/OAuth.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/OAuth.ts:150-159` (`resolveCallbackURL`) still returns `raw` unparsed whenever `raw.startsWith("/")`, so `//evil.com/path` passes through as "safe" and reaches `HttpServerResponse.redirect(outcome.callbackURL)` at OAuth.ts:341/343. `packages/oauth/test/OAuth.test.ts:760/769` only exercises the single-slash `"/settings"` case, confirming the bypass is untested. This is a well-scoped mechanical fix (resolve against `config_.baseUrl`/trustedOrigins, reject protocol-relative forms). Status → ready-for-agent.

**Resolved (2026-09-19):** Same fix as `OAP-001` (shared source line, identical vulnerability and recommended fix) — see that finding's comment.
