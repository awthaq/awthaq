---
ID: "EOTS-001"
Title: "Zero auth-operation spans: planned auth.signin/auth.session.refresh span skeleton never implemented"
Level: high
Category: "architecture"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:516"
Auditor: "effect-observability-tracing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EOTS-001 — Zero auth-operation spans: planned auth.signin/auth.session.refresh span skeleton never implemented

`HIGH` · `architecture` · `password` · reported by **Effect Observability & Tracing Specialist** (`effect-observability-tracing-specialist`)

Status: **resolved**

## Summary

The research corpus's decision (research/01-effect-ecosystem.md:196, restated as decision #8 at :349) specifies 'the auth runtime creates one span per authentication operation (auth.signin, auth.signup, auth.session.refresh — attribute awthaq.plugin, strategy, principal_id)' with plugin-declared child leaves. Grep across all 97 `packages/*/src` files finds zero `withSpan`/`useSpan` call sites: every auth op (password signIn:516, OAuth callback, passkey verify, session issue/verify) runs inside whatever generic span the HTTP router creates, with the first named span appearing only at `SqlModel.makeRepository` repository calls. A slow login cannot be root-caused past 'somewhere in the password plugin' — the exact failure the persona's role exists to prevent.

## Evidence

Source: `packages/password/src/Password.ts:516`

```
const signIn: PasswordShape["signIn"] = Effect.fnUntraced(function* (input) {
        yield* rateLimit(`password:signin:${input.email.toLowerCase()}`, RATE_LIMITS.signIn);
```

## Recommended fix

Add the core-enforced skeleton: wrap each plugin op entry in `Effect.withSpan("auth.signin", ...)` with `awthaq.plugin`/`strategy`/`principal_id` attributes (never credentials), in one place per plugin via a shared helper so naming stays consistent across independently authored plugins.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: observability & tracing
- Full dossier: [`effect-observability-tracing-specialist`](../../.reports/effect-observability-tracing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — evidence quote matches `packages/password/src/Password.ts:516` exactly; `grep -rl "withSpan\|useSpan" packages --include="*.ts"` (excluding tests/lib) returns zero files repo-wide, confirming no auth-operation spans exist anywhere. The research corpus already specifies the exact span names/attributes to add, making this a mechanical (if cross-cutting) implementation task. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `auth-operation-tracing`. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:794`. Fix: Add ticket 27's business-logic spans via one shared helper, starting with every Password operation. (effort M). Full dossier: `.plan/slices/07-password-mfa.md`.

**Resolved (2026-09-29):** Every Password operation (signUp, signUpConcealed, signIn, requestReset, resendVerification, confirmReset, verifyEmail, changePassword, reauthenticate) is an awthaq.password.<operation> span with awthaq.plugin and auth.strategy via the shared Observability.authSpan; the hash check is its own awthaq.password.verify span; user.id is annotated only once the credential is proven (never on a failed sign-in); never the email, password or token. Same helper on OAuth.callback (awthaq.oauth.callback) and Passkey.authenticateVerify, and Sessions issue/verify (see MW-001). Test: Password.test.ts with a recording tracer.
