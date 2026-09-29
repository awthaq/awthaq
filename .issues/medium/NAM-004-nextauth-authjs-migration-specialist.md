---
ID: "NAM-004"
Title: "Provider discovery resolved once at boot and dies the process on failure"
Level: medium
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:444"
Auditor: "nextauth-authjs-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NAM-004 — Provider discovery resolved once at boot and dies the process on failure

`MEDIUM` · `correctness` · `oauth` · reported by **NextAuth.js/Auth.js Migration Specialist** (`nextauth-authjs-migration-specialist`)

Status: **resolved**

## Summary

Auth.js fetches and caches provider discovery lazily per request, so a transient provider outage (or offline local development) degrades only OAuth sign-in. effect-auth resolves every configured provider's discovery document in `make` with `Effect.orDie` (OAuthProvider.resolve, OAuthProvider.ts:116-183): one unreachable issuer at boot prevents the whole auth runtime — and therefore the whole app, since Auth.make output is the app's layer graph — from starting, and a provider rotating its discovery document requires a process restart. Fail-fast configuration is a defensible choice, but conflating 'misconfigured issuer' (boot error) with 'issuer temporarily unreachable' (transient) makes effect-auth strictly less available than the Auth.js incumbent being replaced.

## Evidence

Source: `packages/oauth/src/OAuth.ts:444`

```
// BEH-EA-127: resolved once, at boot — a mismatched or unfetchable
// discovery document dies here, before any request is ever served.
const resolved = yield* Effect.all(
```

## Recommended fix

Split the failure modes: keep config-shape and issuer-mismatch checks at boot, but make the discovery fetch lazy with a bounded refresh (the JWKS cache in verifyIdToken already models refetch-on-miss) or retry with backoff before orDie.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: Auth.js Migration Parity
- Full dossier: [`nextauth-authjs-migration-specialist`](../../.reports/nextauth-authjs-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-outbound-resilience`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:547`. Fix: Split 'misconfigured' (boot die) from 'unreachable' (retry, then optionally lazy), and share one provider registry. (effort M). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option B per plan; user may revisit. New OAuthProviders Context.Service (OAuthProviders.ts) built once and shared by OAuth.layer and OAuthTokenAccess.layer (each provides OAuthProviders.layer; Layer memoization = one discovery fetch per process, asserted by a test). Boot mode (default) keeps fail-fast after ERS-003 retries; OAuthProviderConfig.discovery {mode:'lazy', refresh} resolves on first use via Effect.cachedWithTTL (failures uncached), answers ProviderUnavailable while unreachable, and permanently disables the provider with logged defect on issuer mismatch/malformed doc. OAuthProvider.resolve now returns typed DiscoveryUnavailable for the unreachable case (everything else still dies). Config moved to OAuthConfig.ts (re-exported from OAuth.ts). BEH-EA-127 amended. Tests: 'discovery fails once at boot still registers', lazy down->503->recovers, lazy issuer mismatch never serves, shared registry fetches discovery once. Gates as ECF-001.
