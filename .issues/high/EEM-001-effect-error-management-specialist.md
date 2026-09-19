---
ID: "EEM-001"
Title: "requestReset/resendVerification await the mail send only for existing accounts — observable enumeration side channel"
Level: high
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:584"
Auditor: "effect-error-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EEM-001 — requestReset/resendVerification await the mail send only for existing accounts — observable enumeration side channel

`HIGH` · `security` · `password` · reported by **Effect Typed Error Management Specialist** (`effect-error-management-specialist`)

Status: **resolved**

## Summary

The mail send is awaited inside the account-exists branch of requestReset (and again in resendVerification at line 609), while signUp deliberately forkDetaches+ignores its mail at lines 501-511 with the comment that 'a slow-vs-fast response is itself an enumeration side channel' (research/05-oauth-oidc.md Q48). A real provider send costs hundreds of milliseconds and only happens for existing emails, so response latency distinguishes registered from unregistered addresses; worse, because Mailer.send's error channel is never (see EEM-002), a provider failure during an outage dies the request into a 500 for existing emails only, versus the uniform 202 the contract promises 'whether or not email resolves to an account'. The typed shape (Effect<void, Api.RateLimited>) hides the hazard: nothing in the signature shows the branch-dependent I/O.

## Evidence

Source: `packages/password/src/Password.ts:584`

```
yield* mailer.send({
            to: user.email,
            template: "reset-password",
```

## Recommended fix

Mirror signUp's posture: forkDetach the verification.issue+mailer.send pair with Effect.ignore (or a logging variant) so the 202 goes out immediately and identically for both branches; alternatively give Mailer a typed MailDeliveryFailed and catch it at the handler boundary before answering 202.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 77/100), domain: typed error discipline
- Full dossier: [`effect-error-management-specialist`](../../.reports/effect-error-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 35 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — evidence quote matches `packages/password/src/Password.ts:584` exactly; `mailer.send` is awaited synchronously in `requestReset` (:584) and `resendVerification` (:609), while `signUp` (:501-511) explicitly `forkDetach`+`ignore`s the identical mail dispatch with a comment naming the same enumeration hazard. The fix (mirror `signUp`'s posture) is a mechanical refactor reusing an existing in-file pattern. Status → ready-for-agent.

**Resolved (2026-09-19):** Same fix as `TSS-001` (shared source line, same root cause) — see that finding's comment.
