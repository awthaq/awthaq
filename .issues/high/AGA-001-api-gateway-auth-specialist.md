---
ID: "AGA-001"
Title: "OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer"
Level: high
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:509"
Auditor: "api-gateway-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AGA-001 — OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer

`HIGH` · `security` · `oauth` · reported by **API Gateway Auth Specialist** (`api-gateway-auth-specialist`)

Status: **resolved**

## Summary

The only network-dimension rate limit in the repo keys on request.remoteAddress (OAuth.ts:332), which is the connection-level peer address; a grep for X-Forwarded/Forwarded/proxy across packages/ returns zero matches, so behind the most common deployment topology — any L7 gateway or load balancer — every client in the world arrives from one address and shares one CALLBACK_RATE_LIMIT bucket (20 callbacks/min, OAuth.ts:425). The result is a deployment-wide OAuth login outage at trivial aggregate traffic: attacker or not, the 21st callback in a minute from anyone through the gateway is a 429. The code's own fallback documents the failure honestly ('undefined IP ... shares one bucket, never unthrottled'), and spec BEH-EA-108 deliberately forbids keying on unvalidated headers — but it ships no validated forwarded-header strategy either, leaving operators with no correct way to run this limiter behind a proxy. Failing closed here is safe but turns a standard topology into an availability defect.

## Evidence

Source: `packages/oauth/src/OAuth.ts:509`

```
key: `oauth:callback:${input.ip ?? "unknown"}`,
```

## Recommended fix

Add a trusted-proxy-aware key strategy: a config declaring trusted proxy count or CIDR range, with the bucket key extracted from the rightmost-untrusted X-Forwarded-For hop (spec BEH-EA-108's 'explicit deterministic function' hook is the natural seam). At minimum, document that gateway deployments MUST rate-limit /oauth/*/callback at the edge and that the in-app IP rule collapses to a global bucket there.

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
- [`AGA-005` — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL](low/AGA-005-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, low)_`
- [`ACS-004` — JWKS response cast unvalidated before becoming key material](medium/ACS-004-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, medium)_`
- … 65 more findings touch `packages/oauth/src/OAuth.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Trusted-proxy-aware client-IP rate limiting](../../.scratch/resolve-ready-for-human-findings/issues/23-trusted-proxy-rate-limiting.md) — new `@awthaq/ports/ClientAddress` port (`layerDirect` default = today's raw `remoteAddress`, opt-in `layerTrustedProxy(config)` walks X-Forwarded-For/Forwarded from the right past a configured hop count or trusted CIDR list) resolves the OAuth callback rate-limit key instead of the raw peer address. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/OAuth.ts:509` keys the callback rate limiter on `input.ip ?? "unknown"` alone, `input.ip` comes only from `request.remoteAddress` (`OAuth.ts:332`), and a repo-wide grep for `X-Forwarded`/`Forwarded` returns zero matches, so behind any L7 proxy all clients collapse into one 20/min bucket (`CALLBACK_RATE_LIMIT`, `OAuth.ts:425`). Fixing this requires a security-sensitive design decision (trusted-proxy hop count/CIDR config and its default), not just a code change. Status → ready-for-human.

**Resolved (2026-09-19):** Implemented the design recorded in [Trusted-proxy-aware client-IP rate limiting](../../.scratch/resolve-ready-for-human-findings/issues/23-trusted-proxy-rate-limiting.md): a new stratum-2 `@awthaq/ports/ClientAddress` port (`layerDirect` — byte-for-byte today's raw `remoteAddress`; `layerTrustedProxy(config)` — opt-in, walks `X-Forwarded-For`/`Forwarded` right-to-left past a configured `hopCount` or `trustedCidrs` allowlist, IPv4 and IPv6 both). `OAuth.ts`'s callback handler and `Password.ts`'s `signUp`/`signIn`/`requestReset` handlers all resolve through it now instead of raw `request.remoteAddress`. `layerDirect` is wired into `TestAuth.layer` (so every zero-config composition keeps today's behavior unchanged) and every test/feature-world composition that builds `OAuth`/`Password` directly. 11 new unit tests in `packages/ports/test/ClientAddress.test.ts` cover both strategies, both header dialects, IPv6 CIDRs, and the "header absent/malformed/shorter than trust boundary falls back to remoteAddress" cases — a deliberate mutation of the hopCount indexing confirmed 3 of them fail without the real logic. Full monorepo typecheck and test suite (621 tests) pass. See `NHS-003`'s own comment for the companion `Password` per-IP rate-limit dimension this same change enables.
