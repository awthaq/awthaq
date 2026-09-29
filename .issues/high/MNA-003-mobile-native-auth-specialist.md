---
ID: "MNA-003"
Title: "OAuth callback hands the session to the client only via Set-Cookie on a 302 - unreachable from a native app"
Level: high
Category: "architecture"
Status: ready-for-agent
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:338"
Auditor: "mobile-native-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MNA-003 — OAuth callback hands the session to the client only via Set-Cookie on a 302 - unreachable from a native app

`HIGH` · `architecture` · `oauth` · reported by **Mobile/Native Auth Specialist** (`mobile-native-auth-specialist`)

Status: **ready-for-agent**

## Summary

On successful callback the handler 302s to flow.callbackURL with the session token as a Set-Cookie header. In a native OAuth completion (ASWebAuthenticationSession / Chrome Custom Tabs) that cookie lands in the embedded browser session's cookie jar, which the app cannot read; the app receives only the final redirect URL, which carries no credential. Even if deep-link callback URLs were allowed (they are not - see MNA-004), the return leg still delivers nothing to the app. There is no token-in-fragment, no JSON exchange endpoint, and no app-authenticated handoff alternative.

## Evidence

Source: `packages/oauth/src/OAuth.ts:338`

```
            Sessions.SESSION_COOKIE_NAME,
            Redacted.value(outcome.session.token),
            Sessions.SESSION_COOKIE_ATTRIBUTES,
```

## Recommended fix

Give native clients a real return leg: e.g. embed a short-lived one-time exchange code in the deep-link URL that the app redeems at a JSON endpoint for the session token, or accept the provider code directly from the app (public-client PKCE exchange) and respond with the token in the body.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: mobile client readiness
- Full dossier: [`mobile-native-auth-specialist`](../../.reports/mobile-native-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `OAuth.ts:334-343` (evidence at lines 338-340) shows the callback handler's only success path is a 302 redirect with `Sessions.SESSION_COOKIE_NAME`/token delivered via `Set-Cookie`; no JSON/body exchange or fragment-based handoff exists. In a native `ASWebAuthenticationSession`/Custom Tabs flow that cookie lands in the ephemeral browser session, unreachable by the app. Designing a real native return leg (exchange code, public-client PKCE, etc.) is an architecture decision, not a mechanical patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Native/mobile app session bootstrap (non-cookie delivery)](../../.scratch/resolve-ready-for-human-findings/issues/17-native-mobile-session-bootstrap.md) — Resolved via a one-time, single-use exchange code (stored in the existing `KeyValueStore` port) embedded in the native-mode OAuth callback's deep-link redirect, redeemed at a new `/oauth/token` endpoint for the real session token — never the live token itself in the URL. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `native-session-bootstrap`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:431`. Fix: Implement decision ticket 17: native-mode authorize, an exchange code minted at callback, and a JSON redemption endpoint returning the session token. (effort L). Full dossier: `.plan/slices/03-oauth-flow.md`.
