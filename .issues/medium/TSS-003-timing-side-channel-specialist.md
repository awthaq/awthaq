---
ID: "TSS-003"
Title: "OAuth callback compares state correlation secret with non-constant-time string !=="
Level: medium
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:529"
Auditor: "timing-side-channel-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TSS-003 — OAuth callback compares state correlation secret with non-constant-time string !==

`MEDIUM` · `security` · `oauth` · reported by **Timing / Side-Channel Specialist** (`timing-side-channel-specialist`)

Status: **resolved**

## Summary

The state parameter embeds a Verification secret (`<identifier>.<value>`, encoded at OAuth.ts:495) and the correlation cookie carries the same value; the two are compared with JavaScript !==, which short-circuits on the first differing character. The codebase's own standard for exactly this comparison shape — CSRF double-submit tokens in packages/server/src/Csrf.ts:38-41 — wraps it in a constantTimeEqual loop, and BEH-EA-056's spec text (spec/behaviors/07-sessions.md:132) names "a comparison whose timing can vary with how many leading bytes match" as the channel to deny. A script in the victim's browser issuing repeated callback probes could in principle recover cookie bytes via the classic prefix-matching timing attack; practical exploitability over network jitter is low, but the fix is a one-line reuse of an existing helper and the inconsistency with Csrf.ts is inexplicable under the repo's own stated threat model.

## Evidence

Source: `packages/oauth/src/OAuth.ts:529`

```
const decoded = decodeState(input.state);
if (Option.isNone(decoded) || input.cookieState !== input.state) {
  return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
```

## Recommended fix

Route the cookieState/state comparison through a shared constantTimeEqual helper — promote Sessions.ts:48's constantTimeEqual into a common module (four local copies exist today: Sessions.ts:48, ChallengeStore.ts:230, Csrf.ts:38, PasswordHasher.ts:70) and use it here.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: timing side channels
- Full dossier: [`timing-side-channel-specialist`](../../.reports/timing-side-channel-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-callback-http-hardening`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:632`. Fix: Compare cookieState and state in constant time over fixed-length digests, using a shared helper. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** New packages/core/src/ConstantTime.ts (constantTimeEqual over bytes with length folded into the accumulator, constantTimeEqualString), exported from @awthaq/core, with test/ConstantTime.test.ts. OAuth callback now compares __Host-oauth-state to the returned state as constantTimeEqual(sha256(cookie), sha256(state)); no !== on secret material remains in OAuth.ts (existing mismatched-cookie test is the behavioural pin). NOT done here (other programs' files): replacing the private copies in Sessions.ts, Csrf.ts, ChallengeStore.ts, PasswordHasher.ts. Gates as CSS-004.
