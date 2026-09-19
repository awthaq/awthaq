---
ID: "NHS-003"
Title: "Rate limiting has no real client-IP dimension and no trusted-proxy story"
Level: high
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:332"
Auditor: "node-http-server-integration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NHS-003 — Rate limiting has no real client-IP dimension and no trusted-proxy story

`HIGH` · `security` · `oauth` · reported by **Node HTTP Server Integration Specialist** (`node-http-server-integration-specialist`)

Status: **resolved**

## Summary

The only IP keying in the repo is OAuth's raw socket remoteAddress. Behind the reverse proxy every real deployment uses, that is the proxy's address, so all clients share one 20/min callback bucket — a single noisy NAT or the proxy itself locks everyone out, and an attacker can deliberately exhaust the shared bucket. On Request-to-Response hosts via toWebHandler, remoteAddress is None and the code itself documents that 'undefined IP shares one bucket' (OAuth.ts:421-423), collapsing the whole Internet into one global 20/min limit. Meanwhile password endpoints key purely on payload email (Password.ts:397-408), so credential-stuffing across many victim accounts is never throttled per source. A repo-wide grep finds no X-Forwarded-For handling, hop-count config, or trust boundary anywhere; the trust-boundary question the target raises is not answered, it is absent.

## Evidence

Source: `packages/oauth/src/OAuth.ts:332`

```
          cookieState,
          ...(Option.isSome(request.remoteAddress) ? { ip: request.remoteAddress.value } : {}),
        });
```

## Recommended fix

Add a trusted-proxy configuration at the serving stratum (allowed proxy CIDRs/hop count or explicit forwarded-header opt-in), derive one canonical client-key from it, use it as the OAuth bucket key, and add a per-IP dimension alongside the email key on password endpoints; document the behavior when no trusted proxy is configured.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: HTTP server integration
- Full dossier: [`node-http-server-integration-specialist`](../../.reports/node-http-server-integration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

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

**Decision (2026-09-19):** Resolved via [Trusted-proxy-aware client-IP rate limiting](../../.scratch/resolve-ready-for-human-findings/issues/23-trusted-proxy-rate-limiting.md) — new `@awthaq/ports/ClientAddress` port resolves proxy-aware client IPs for both OAuth callback and password endpoints; password `signUp`/`signIn`/`requestReset` gain an independent per-IP rate-limit dimension alongside the existing per-email key. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/OAuth.ts:331` still keys the callback rate limit only on `request.remoteAddress` (raw socket address, `Option.none()` shared bucket documented at OAuth.ts:417-423), `packages/password/src/Password.ts:~390-413` keys `signUp`/`signIn`/`requestReset` purely on the payload `email` with no IP dimension, and a repo-wide grep for `x-forwarded-for`/`trusted-proxy`/`trustedProxy` finds zero matches — no trusted-proxy handling exists anywhere. The fix requires introducing a trusted-proxy/forwarded-header trust boundary at the serving stratum, a genuine security/architecture decision (which headers to trust, CIDR/hop-count config, cross-package rollout to both oauth and password), not a local mechanical patch. Status → ready-for-human.

**Resolved (2026-09-19):** `ClientAddress` (see `AGA-001`'s own comment) closes this finding's trusted-proxy half. Its own "add a per-IP dimension alongside the email key on password endpoints" half is implemented too: `signUp`/`signIn`/`requestReset` each register a second, independent per-IP rate-limit rule (`signUpByIp` 20/hour, `signInByIp` 30/15min, `requestResetByIp` 30/15min) alongside their existing per-email rule — two independent dimensions, not a combined key, so an attacker rotating IP per attempt against one victim email still trips the per-email limit, and one rotating email per attempt from one IP still trips the per-IP limit. `PasswordHandlers` now threads `request: HttpServerRequest.HttpServerRequest` into `signUp`/`signIn`/`requestReset` (mirroring `OAuthHandlers`'s own `callback` handler) to resolve it. Regression tests for `signIn` and `requestReset` spray many distinct, never-seen emails from one IP and assert the next one throttles anyway — each verified to genuinely fail (a defect from an unexpected success, or literally hanging past the per-account limiter's own budget) with its own per-IP `rateLimit` call reverted. Full monorepo typecheck and test suite (621 tests) pass.
