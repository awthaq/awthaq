---
ID: "ARF-002"
Title: "WeakPassword is checked after the reset token is consumed — a policy mistake burns the single-use token"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "password"
Source: "packages/password/src/Password.ts:635"
Auditor: "account-recovery-flow-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ARF-002 — WeakPassword is checked after the reset token is consumed — a policy mistake burns the single-use token

`MEDIUM` · `correctness` · `password` · reported by **Account Recovery Flow Specialist** (`account-recovery-flow-specialist`)

Status: **ready-for-agent**

## Summary

confirmReset consumes the token (line 630) before evaluating the password policy (line 635), so a user who submits a too-short or breached password gets WeakPassword with the token already destroyed — they must request and click a fresh reset link to try again. This directly violates REQ-EA-165 ('A failure applying the authorized state change leaves the token unconsumed') and is the user-visible face of ARF-001. It also hands an attacker who glimpses a token a one-shot DoS on the legitimate user's reset attempt.

## Evidence

Source: `packages/password/src/Password.ts:635`

```
const hints = yield* checkPolicy(httpClient, crypto, input.password, config);
        if (hints.length > 0) {
          return yield* Effect.fail(new PasswordApi.WeakPassword({ hints }));
```

## Recommended fix

Run checkPolicy before verification.consume (it touches no account state), or perform the whole sequence inside the ARF-001 transaction so WeakPassword rolls the consumption back.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Account Recovery
- Full dossier: [`account-recovery-flow-specialist`](../../.reports/account-recovery-flow-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-001` — confirmReset violates the spec's single-transaction invariant: consume, password change, and revocation commit independently](high/ARF-001-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ARF-003` — requestReset/resendVerification send mail inline, leaking account existence through response latency](medium/ARF-003-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-004` — requestReset issues tokens for accounts with no password credential; confirmReset then dies with a 500](medium/ARF-004-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-007` — confirmReset slices the token identifier without validating its prefix, turning a valid verify-email token into a 500](low/ARF-007-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-008` — Reset works for unverified accounts (good) but completing a reset neither confers nor requires verification, leaving the account still locked](low/ARF-008-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-009` — Mailed reset token embeds the internal userId, leaking a UUIDv7 (creation timestamp) inside a recovery artifact](low/ARF-009-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-010` — Reset-request rate limit is keyed solely on the attacker-chosen email — unlimited spray across addresses](low/ARF-010-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`AR-001` — Documented MFA step-up flow has no attachment point: nothing hooks session issuance](high/AR-001-aeneas-rekkas.md) `_(aeneas-rekkas, high)_`
- … 41 more findings touch `packages/password/src/Password.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `password-recovery-correctness`. Already fixed by commit 34caae8. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:986`. Fix: Evaluate the password policy before opening the transaction / consuming the token. (effort S). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.
