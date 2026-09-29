---
ID: "ERS-003"
Title: "Zero retry/backoff Schedules: one transient provider error fails OAuth callback permanently"
Level: medium
Category: "architecture"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:246"
Auditor: "effect-runtime-scheduler-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ERS-003 — Zero retry/backoff Schedules: one transient provider error fails OAuth callback permanently

`MEDIUM` · `architecture` · `oauth` · reported by **Effect Runtime & Scheduler Specialist** (`effect-runtime-scheduler-specialist`)

Status: **resolved**

## Summary

Grep across all packages/*/src finds no Schedule usage, no retry, no repeat, no jitter — the codebase contains no backoff policy of any kind. The affected paths are externally owned and idempotent GETs where a retry is safe: JWKS fetch on cache miss (OAuth.ts:246, jwt/verify.ts:83) fails the whole OAuth callback with OAuthCallbackFailed on a single provider blip, discovery resolution dies at boot (OAuthProvider.ts:109-113, acceptable), and token exchange (OAuth.ts:192) has no resilience either. Meanwhile spec/behaviors/14-rate-limiting.md:60 explicitly reasons that retryAfterMillis exists so a client can 'back off, then retry' — that guidance is applied to API consumers but never to the server's own outbound calls. Note the contrast with the persona red flag: the repo does not use fixed-delay no-jitter retries; it uses none at all, which for flaky upstreams is the worse half of the same problem.

## Evidence

Source: `packages/oauth/src/OAuth.ts:246`

```
const fetchAndCacheJwks = httpClient.get(jwksUri).pipe(
      Effect.flatMap((response) => response.json),
```

## Recommended fix

Add a narrowly scoped retry policy to idempotent outbound GETs only: Effect.retry(Schedule.exponential('50 millis').pipe(Schedule.jittered, Schedule.compose(Schedule.recurs(2)))) on JWKS fetch and discovery. Leave the authorization-code token exchange non-retried (it is single-use and provider-idempotency is not guaranteed), and document that choice next to exchangeCode.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: runtime scheduling
- Full dossier: [`effect-runtime-scheduler-specialist`](../../.reports/effect-runtime-scheduler-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-outbound-resilience`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:323`. Fix: Retry only idempotent GETs (JWKS, discovery, userinfo) with jittered exponential backoff inside the deadline. Never retry the single-use code exchange. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** ProviderHttp.retrying = HttpClient.retryTransient(errors-and-responses, jittered exponential) with OAuthConfig.retry {times:2, base:50ms}; used for JWKS, userinfo and discovery GETs only, inside each call's deadline. exchangeCode and the refresh grant stay on the plain client (single-use code / rotating refresh token). Tests: JWKS 503-then-200 and userinfo 503-then-200 succeed, discovery 503-then-200 registers at boot, token endpoint 503 called exactly once; mutation-checked red (retrying client replaced by plain -> the two retry tests fail). Gates as ECF-001.
