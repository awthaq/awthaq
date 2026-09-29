---
ID: "RBS-008"
Title: "OAuth callback IP keying uses the raw socket address with no trusted-proxy handling — shared bucket behind any reverse proxy"
Level: medium
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:509"
Auditor: "rate-limiting-brute-force-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RBS-008 — OAuth callback IP keying uses the raw socket address with no trusted-proxy handling — shared bucket behind any reverse proxy

`MEDIUM` · `security` · `oauth` · reported by **Rate Limiting & Brute-Force Defense Specialist** (`rate-limiting-brute-force-specialist`)

Status: **resolved**

## Summary

The handler passes HttpServerRequest.remoteAddress (OAuth.ts:332) — the TCP peer address. Behind the reverse-proxy/ingress topology an HTTP auth server is normally deployed in, every client's socket address is the proxy's, so all OAuth callbacks funnel into one 20/min bucket: any attacker (or ordinary traffic spike) can lock every user of every provider out of completing sign-in, a third-party-weaponizable DoS of the whole OAuth surface. The same collapse hits the explicit `unknown` fallback bucket when remoteAddress is absent (documented at OAuth.ts:421-423 as deliberate). No X-Forwarded-For or trusted-hop handling exists anywhere in the packages (grep across packages/ returns nothing).

## Evidence

Source: `packages/oauth/src/OAuth.ts:509`

```
key: `oauth:callback:${input.ip ?? "unknown"}`,
```

## Recommended fix

Add a configured trusted-proxy hop count and derive the client IP from the standard Forwarded/X-Forwarded-For chain only from trusted peers, falling back to the socket address; document that unproxied deployments need zero config, and consider a per-provider cap alongside the per-IP one.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: brute-force defense
- Full dossier: [`rate-limiting-brute-force-specialist`](../../.reports/rate-limiting-brute-force-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `oauth-callback-http-hardening`. Already fixed by commit a3b7255. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:423`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.
