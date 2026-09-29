---
ID: "ARF-007"
Title: "confirmReset slices the token identifier without validating its prefix, turning a valid verify-email token into a 500"
Level: low
Category: "correctness"
Status: ready-for-agent
Package: "password"
Source: "packages/password/src/Password.ts:640"
Auditor: "account-recovery-flow-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ARF-007 — confirmReset slices the token identifier without validating its prefix, turning a valid verify-email token into a 500

`LOW` · `correctness` · `password` · reported by **Account Recovery Flow Specialist** (`account-recovery-flow-specialist`)

Status: **ready-for-agent**

## Summary

decodeVerificationToken splits only on the last '.', and confirmReset never checks that the decoded identifier starts with 'reset-password:'. Presenting a structurally valid verify-email:<id>.<hex> token to /password/confirm-reset consumes that token (the Verification layer matches identifier+hash faithfully) and then slices at offset 15, producing a garbage userId whose account lookup falls into ARF-004's Effect.die — a 500 that also destroyed the user's email-verification token. Purpose-scoping holds cryptographically (REQ-EA-161), but the prefix assumption is unchecked at the extraction site, and verifyEmail (line 684) mirrors the same pattern.

## Evidence

Source: `packages/password/src/Password.ts:640`

```
const userId = Users.UserId(identifier.slice(RESET_PREFIX.length));
```

## Recommended fix

After decode, verify identifier.startsWith(RESET_PREFIX) (and VERIFY_PREFIX in verifyEmail) and fail with TokenConsumed otherwise, before rate limiting or consuming.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Account Recovery
- Full dossier: [`account-recovery-flow-specialist`](../../.reports/account-recovery-flow-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-001` — confirmReset violates the spec's single-transaction invariant: consume, password change, and revocation commit independently](high/ARF-001-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ARF-002` — WeakPassword is checked after the reset token is consumed — a policy mistake burns the single-use token](medium/ARF-002-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-003` — requestReset/resendVerification send mail inline, leaking account existence through response latency](medium/ARF-003-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-004` — requestReset issues tokens for accounts with no password credential; confirmReset then dies with a 500](medium/ARF-004-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-008` — Reset works for unverified accounts (good) but completing a reset neither confers nor requires verification, leaving the account still locked](low/ARF-008-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-009` — Mailed reset token embeds the internal userId, leaking a UUIDv7 (creation timestamp) inside a recovery artifact](low/ARF-009-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-010` — Reset-request rate limit is keyed solely on the attacker-chosen email — unlimited spray across addresses](low/ARF-010-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`AR-001` — Documented MFA step-up flow has no attachment point: nothing hooks session issuance](high/AR-001-aeneas-rekkas.md) `_(aeneas-rekkas, high)_`
- … 41 more findings touch `packages/password/src/Password.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-recovery-correctness`. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:968`. Fix: Validate the purpose prefix right after decode in confirmReset and verifyEmail. (effort S). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.
