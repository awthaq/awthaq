---
ID: "MNA-001"
Title: "No native client can ever obtain its first session token"
Level: high
Category: "api"
Status: ready-for-agent
Package: "password"
Source: "packages/password/src/Password.ts:283"
Auditor: "mobile-native-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MNA-001 — No native client can ever obtain its first session token

`HIGH` · `api` · `password` · reported by **Mobile/Native Auth Specialist** (`mobile-native-auth-specialist`)

Status: **ready-for-agent**

## Summary

signUp and signIn return toSessionDto(issued.session) - a SessionDto with no token field (packages/api/src/Session.ts:18-25) - and deliver the raw token exclusively as an httpOnly __Host-session Set-Cookie (SESSION_COOKIE_ATTRIBUTES, packages/core/src/Sessions.ts:124-129). The bearer resolution path (Api.BearerToken, wired in AuthenticationLive) and the docs' native recipe (bearer token pulled from a Keychain via transformClient, spec/behaviors/09-authentication-middleware.md:55) both presume the app already holds a token; nothing in any shipped plugin ever puts one where a non-browser client can read it. Every mobile/CLI consumer is locked out at the first request.

## Evidence

Source: `packages/password/src/Password.ts:283`

```
yield* HttpApiBuilder.securitySetCookie(
          Api.SessionCookie,
          Redacted.value(issued.token),
```

## Recommended fix

Add a token-delivery mode for non-browser clients: either return the token in the signIn/signUp response body behind an explicit opt-in contract variant, or ship a dedicated native sign-in endpoint; document that cookie mode remains the browser default.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: mobile client readiness
- Full dossier: [`mobile-native-auth-specialist`](../../.reports/mobile-native-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-001` — confirmReset violates the spec's single-transaction invariant: consume, password change, and revocation commit independently](high/ARF-001-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ARF-002` — WeakPassword is checked after the reset token is consumed — a policy mistake burns the single-use token](medium/ARF-002-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-003` — requestReset/resendVerification send mail inline, leaking account existence through response latency](medium/ARF-003-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-004` — requestReset issues tokens for accounts with no password credential; confirmReset then dies with a 500](medium/ARF-004-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-007` — confirmReset slices the token identifier without validating its prefix, turning a valid verify-email token into a 500](low/ARF-007-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-008` — Reset works for unverified accounts (good) but completing a reset neither confers nor requires verification, leaving the account still locked](low/ARF-008-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-009` — Mailed reset token embeds the internal userId, leaking a UUIDv7 (creation timestamp) inside a recovery artifact](low/ARF-009-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-010` — Reset-request rate limit is keyed solely on the attacker-chosen email — unlimited spray across addresses](low/ARF-010-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- … 41 more findings touch `packages/password/src/Password.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `Password.ts:283-287` (and the identical pattern at `signUp`, `Passkey.ts:319`) matches the evidence: `issued.token` only ever reaches the client via `HttpApiBuilder.securitySetCookie`, and `packages/api/src/Session.ts:18-25`'s `SessionDto` carries no token field. `Api.BearerToken` is declared as a security scheme (`Api.ts:103`) but nothing shipped ever populates a bearer credential for a client to use. Adding a token-delivery mode is a real API-contract/security-posture decision (opt-in body token vs. dedicated native endpoint), not a small patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Native/mobile app session bootstrap (non-cookie delivery)](../../.scratch/resolve-ready-for-human-findings/issues/17-native-mobile-session-bootstrap.md) — Resolved via an opt-in `X-Awthaq-Token-Delivery: bearer` request header that makes `password`/`passkey` session-minting responses return the raw token in the body instead of `Set-Cookie`, mutually exclusive with cookie mode and non-breaking for existing browser clients. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `native-token-delivery`. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:383`. Fix: Implement ticket 17's opt-in bearer delivery for every session-minting response. (effort M). Full dossier: `.plan/slices/07-password-mfa.md`.
