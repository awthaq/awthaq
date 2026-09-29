---
ID: "AGA-005"
Title: "redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL"
Level: low
Category: "correctness"
Status: ready-for-agent
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:496"
Auditor: "api-gateway-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AGA-005 — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL

`LOW` · `correctness` · `oauth` · reported by **API Gateway Auth Specialist** (`api-gateway-auth-specialist`)

Status: **ready-for-agent**

## Summary

Both authorize (line 496) and token exchange (line 579) build redirect_uri purely from config_.baseUrl — request Host and X-Forwarded-Host are never consulted (grep: zero forwarded-header reads repo-wide). This is the secure choice: a gateway or proxy cannot poison redirect_uri by mangling Host, and the same configured value is used for registration and verification. The operational flip side is undocumented: behind a gateway, config.baseUrl must equal the public URL or the provider redirects users to a host that never reaches the callback (404), and the default is 'http://localhost:3000' (OAuth.ts:62) while the shipped example binds plain HTTP on :3001 (examples/memory-server/index.ts:85) with no TLS or proxy note anywhere. An operator lift-and-shifting the example behind a gateway gets a broken OAuth flow with no diagnostic pointing at baseUrl.

## Evidence

Source: `packages/oauth/src/OAuth.ts:496`

```
const redirectUri = `${config_.baseUrl}/oauth/${providerId}/callback`;
```

## Recommended fix

Document the behind-gateway requirement (baseUrl MUST be the public scheme+host; TLS terminates at the proxy) in the OAuth config surface and the example README, and consider a boot-time warning when baseUrl still carries its localhost default.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Gateway deployment posture
- Full dossier: [`api-gateway-auth-specialist`](../../.reports/api-gateway-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-001` — Scheme-relative //host callbackURL bypasses the trusted-origin allowlist (open redirect)](high/AP-001-aaron-parecki.md) `_(aaron-parecki, high)_`
- [`AP-003` — id_token aud accepted only as an exact string; array-form audiences rejected](medium/AP-003-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-004` — Userinfo claims merged over id_token claims without the required sub equality check](medium/AP-004-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-006` — Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored](medium/AP-006-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-008` — Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires](low/AP-008-aaron-parecki.md) `_(aaron-parecki, low)_`
- [`AH-002` — JWKS response cast wholesale with as unknown as and cached unvalidated](medium/AH-002-anders-hejlsberg.md) `_(anders-hejlsberg, medium)_`
- [`AGA-001` — OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer](high/AGA-001-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, high)_`
- [`ACS-004` — JWKS response cast unvalidated before becoming key material](medium/ACS-004-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, medium)_`
- … 65 more findings touch `packages/oauth/src/OAuth.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-config-safety`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:600`. Fix: Document that baseUrl must be the public scheme+host. The boot validation arrives with PDR-005. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.
