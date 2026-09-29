---
ID: "ARF-004"
Title: "requestReset issues tokens for accounts with no password credential; confirmReset then dies with a 500"
Level: medium
Category: "correctness"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:650"
Auditor: "account-recovery-flow-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ARF-004 — requestReset issues tokens for accounts with no password credential; confirmReset then dies with a 500

`MEDIUM` · `correctness` · `password` · reported by **Account Recovery Flow Specialist** (`account-recovery-flow-specialist`)

Status: **resolved**

## Summary

requestReset (lines 573-589) looks up the user by email and mails a reset token without ever checking that the account has a password credential — an OAuth-only user (created via @awthaq/oauth with no PASSWORD_PROVIDER_ID account) receives a reset link whose confirmation always hits the Effect.die above, surfacing as a 500 to the user after they clicked the emailed link. The comment claims the credential's absence 'is a defect, not a request-level condition', but it is a reachable request-level condition for any mixed-plugin deployment. The response-level enumeration posture is unaffected (still 202), but the recovery path is broken and the mail is a lie for such accounts.

## Evidence

Source: `packages/password/src/Password.ts:650`

```
onNone: () =>
                  Effect.die(new Error(`awthaq: password credential missing for user ${userId}`)),
```

## Recommended fix

Check accounts.findByProviderSubject(PASSWORD_PROVIDER_ID, user.id) in requestReset and skip the mail when absent (still 202), or have confirmReset map the missing-credential case to TokenConsumed instead of a defect.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Account Recovery
- Full dossier: [`account-recovery-flow-specialist`](../../.reports/account-recovery-flow-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-001` — confirmReset violates the spec's single-transaction invariant: consume, password change, and revocation commit independently](high/ARF-001-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ARF-002` — WeakPassword is checked after the reset token is consumed — a policy mistake burns the single-use token](medium/ARF-002-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-003` — requestReset/resendVerification send mail inline, leaking account existence through response latency](medium/ARF-003-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-007` — confirmReset slices the token identifier without validating its prefix, turning a valid verify-email token into a 500](low/ARF-007-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-008` — Reset works for unverified accounts (good) but completing a reset neither confers nor requires verification, leaving the account still locked](low/ARF-008-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-009` — Mailed reset token embeds the internal userId, leaking a UUIDv7 (creation timestamp) inside a recovery artifact](low/ARF-009-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-010` — Reset-request rate limit is keyed solely on the attacker-chosen email — unlimited spray across addresses](low/ARF-010-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`AR-001` — Documented MFA step-up flow has no attachment point: nothing hooks session issuance](high/AR-001-aeneas-rekkas.md) `_(aeneas-rekkas, high)_`
- … 41 more findings touch `packages/password/src/Password.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-recovery-correctness`. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:1005`. Fix: Skip reset issuance for credential-less accounts (inside the forked fiber, preserving uniform latency) and map the missing-credential case to TokenConsumed defensively. (effort S). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** requestReset looks up the password credential inside the dispatched work (uniform latency kept) and mails template reset-password-unavailable (no token) for OAuth-/passkey-only accounts; confirmReset maps a missing credential to TokenConsumed instead of a defect. Tests (red first): PasswordRecovery.test.ts. BEH-EA-117 updated.
