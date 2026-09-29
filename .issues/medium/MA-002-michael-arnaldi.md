---
ID: "MA-002"
Title: "Ambient Date.now() inside an Effect bypasses the Clock, breaking TestClock determinism"
Level: medium
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:273"
Auditor: "michael-arnaldi"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MA-002 — Ambient Date.now() inside an Effect bypasses the Clock, breaking TestClock determinism

`MEDIUM` · `correctness` · `oauth` · reported by **Michael Arnaldi — Creator of Effect** (`michael-arnaldi`)

Status: **resolved**

## Summary

id_token expiry is checked against the ambient wall clock instead of the Effect Clock (DateTime.now, as every other time-sensitive path in this codebase — Sessions.verify, Verification.consume, RateLimiter — correctly uses). Consequences: the check cannot be driven by TestClock, so tests of the exp/nonce rejection paths must inject pre-computed wall-clock claims (which the test file indeed does at OAuth.test.ts:819); time is read twice non-atomically across a network-adjacent flow; and any environment that swaps the clock service (edge runtimes, replay/debug runtimes) silently loses control of token validation. This is the one place the codebase's own 'capability over ambient global' rule is violated.

## Evidence

Source: `packages/oauth/src/OAuth.ts:273`

```
      exp === undefined ||
      Date.now() >= exp * 1000 ||
      (nonce !== undefined && claims["nonce"] !== nonce)
```

## Recommended fix

Replace with `now <- DateTime.now` and compare epoch millis, matching Sessions.ts:482's existing pattern; no shape changes needed since verifyIdToken is already an Effect.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Effect v4 architecture
- Full dossier: [`michael-arnaldi`](../../.reports/michael-arnaldi/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-oidc-claims-integrity`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:356`. Fix: Read time once per verification from the Effect Clock and use it for exp/iat/nbf and the JWKS cache age. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** id_token verification now lives in new packages/oauth/src/IdToken.ts and reads Clock.currentTimeMillis once per verification, shared by exp/iat/nbf and the JWKS cache age (fetchedAt written from the Clock too); grep Date.now packages/oauth/src is empty. Tests (OAuth.test.ts): 'an id_token becomes expired when the TestClock advances past exp' and 'the JWKS cache refetches only after the TestClock passes the 15 minute TTL' (both impossible against Date.now); the pre-existing 'expired id_token' test now uses a Clock-relative exp (it was red against Clock). Gates: tsc -b, tsconfig.test.json, vitest 936 pass (one unrelated password-hashing timeout under machine load, green on rerun), test:bdd 106, spec:verify:strict, oxlint packages/oauth, pnpm circular.
