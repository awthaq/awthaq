---
ID: "ARF-003"
Title: "requestReset/resendVerification send mail inline, leaking account existence through response latency"
Level: medium
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:584"
Auditor: "account-recovery-flow-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ARF-003 — requestReset/resendVerification send mail inline, leaking account existence through response latency

`MEDIUM` · `security` · `password` · reported by **Account Recovery Flow Specialist** (`account-recovery-flow-specialist`)

Status: **resolved**

## Summary

For a known email, requestReset synchronously awaits verification.issue plus a real mailer.send; for an unknown email it returns after one user lookup. The codebase's own signUp explicitly forks the identical send because 'response latency must not depend on mail-provider latency, and ... a slow-vs-fast response is itself an enumeration side channel' (lines 497-500, citing research Q48) — requestReset (584-588) and resendVerification (609-613) reintroduce exactly that oracle on the two endpoints whose uniform-202 contract (BEH-EA-064/086) is otherwise carefully tested. Behind a slow SMTP provider, an attacker can differentiate registered from unregistered addresses despite identical status codes and bodies.

## Evidence

Source: `packages/password/src/Password.ts:584`

```
yield* mailer.send({
            to: user.email,
            template: "reset-password",
```

## Recommended fix

Fork the issue+send pair with Effect.forkDetach and Effect.ignore in requestReset and resendVerification, matching signUp's posture (and BEH-EA-113's REQ-EA-306 rationale applied uniformly).

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Account Recovery
- Full dossier: [`account-recovery-flow-specialist`](../../.reports/account-recovery-flow-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-001` — confirmReset violates the spec's single-transaction invariant: consume, password change, and revocation commit independently](high/ARF-001-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ARF-002` — WeakPassword is checked after the reset token is consumed — a policy mistake burns the single-use token](medium/ARF-002-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-004` — requestReset issues tokens for accounts with no password credential; confirmReset then dies with a 500](medium/ARF-004-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-007` — confirmReset slices the token identifier without validating its prefix, turning a valid verify-email token into a 500](low/ARF-007-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-008` — Reset works for unverified accounts (good) but completing a reset neither confers nor requires verification, leaving the account still locked](low/ARF-008-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-009` — Mailed reset token embeds the internal userId, leaking a UUIDv7 (creation timestamp) inside a recovery artifact](low/ARF-009-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-010` — Reset-request rate limit is keyed solely on the attacker-chosen email — unlimited spray across addresses](low/ARF-010-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`AR-001` — Documented MFA step-up flow has no attachment point: nothing hooks session issuance](high/AR-001-aeneas-rekkas.md) `_(aeneas-rekkas, high)_`
- … 41 more findings touch `packages/password/src/Password.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `mail-delivery-reliability`. Already fixed by commit bd1625c. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:903`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
