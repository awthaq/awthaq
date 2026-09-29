---
ID: "ECF-001"
Title: "No deadline on any outbound HTTP call: five third-party calls can pin auth request fibers"
Level: high
Category: "correctness"
Status: ready-for-agent
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:208"
Auditor: "effect-concurrency-fiber-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECF-001 — No deadline on any outbound HTTP call: five third-party calls can pin auth request fibers

`HIGH` · `correctness` · `oauth` · reported by **Effect Concurrency & Fiber Specialist** (`effect-concurrency-fiber-specialist`)

Status: **ready-for-agent**

## Summary

Effect.timeout appears nowhere in packages/*/src, yet the runtime makes five outbound calls on auth hot paths: OAuth token exchange (OAuth.ts:208), OIDC discovery (OAuthProvider.ts:140), provider JWKS fetch (OAuth.ts:246), standalone-JWT JWKS fetch (verify.ts:83), and the HIBP range lookup on sign-up (Password.ts:215). Each request fiber therefore waits on whatever the transport's incidental defaults are — a slow or half-open provider connection stalls that sign-up/callback for the transport's full default window, and a burst of such requests accumulates parked fibers against server connection limits. An auth runtime should never let third-party TCP behavior set its own latency bound.

## Evidence

Source: `packages/oauth/src/OAuth.ts:208`

```
const response = yield* httpClient.post(provider.tokenEndpoint, {
      body: HttpBody.urlParams(form),
    });
```

## Recommended fix

Wrap every outbound call in Effect.timeout with a policy deadline (e.g. 5-10s for token exchange/JWKS, shorter for HIBP), composing the error into the existing typed failure (OAuthCallbackFailed / breach-check's fail-open branch). A single shared `boundedCall` helper over HttpClient would keep all five sites uniform.

## Context

- Auditor verdict on this domain: **needs-work** (score 68/100), domain: Concurrency & Fibers
- Full dossier: [`effect-concurrency-fiber-specialist`](../../.reports/effect-concurrency-fiber-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — evidence quote matches `packages/oauth/src/OAuth.ts:208` exactly, and `grep -rn "Effect.timeout" packages/*/src` returns zero hits repo-wide; `OAuthProvider.ts:140` (discovery) and `Password.ts:215` (HIBP) confirm the other undeadlined outbound calls too. Fix is a mechanical `Effect.timeout` wrap at each site. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-outbound-resilience`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:244`. Fix: Give every outbound provider call a policy deadline, configurable per call class, and map a timeout into the typed failure channel. (effort M). Full dossier: `.plan/slices/03-oauth-flow.md`.
