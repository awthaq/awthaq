---
ID: "ARF-009"
Title: "Mailed reset token embeds the internal userId, leaking a UUIDv7 (creation timestamp) inside a recovery artifact"
Level: low
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:177"
Auditor: "account-recovery-flow-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ARF-009 — Mailed reset token embeds the internal userId, leaking a UUIDv7 (creation timestamp) inside a recovery artifact

`LOW` · `security` · `password` · reported by **Account Recovery Flow Specialist** (`account-recovery-flow-specialist`)

Status: **resolved**

## Summary

The mailed token is '<identifier>.<secret>' where identifier is 'reset-password:<userId>' and userId is a UUIDv7 (Verification.ts:151), so every reset and verification email exposes the recipient-agnostic internal user id and, via UUIDv7's timestamp field, the account's creation time — to link-preview bots, mail scanners, and forwarding. The value half is hashed at rest and the secret is 256-bit, so this is disclosure hardening, not an exploit; but recovery emails are the most-forwarded artifacts an auth system produces and need not carry enumeration-friendly state.

## Evidence

Source: `packages/password/src/Password.ts:177`

```
const encodeVerificationToken = (identifier: string, value: Redacted.Redacted<string>): string =>
  `${identifier}.${Redacted.value(value)}`;
```

## Recommended fix

Issue an opaque per-token public id (the VerificationTokenId already exists) in the identifier slot, or keep the secret alone in the mail and resolve the identifier server-side from a second keyed component.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Account Recovery
- Full dossier: [`account-recovery-flow-specialist`](../../.reports/account-recovery-flow-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-001` — confirmReset violates the spec's single-transaction invariant: consume, password change, and revocation commit independently](high/ARF-001-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ARF-002` — WeakPassword is checked after the reset token is consumed — a policy mistake burns the single-use token](medium/ARF-002-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-003` — requestReset/resendVerification send mail inline, leaking account existence through response latency](medium/ARF-003-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-004` — requestReset issues tokens for accounts with no password credential; confirmReset then dies with a 500](medium/ARF-004-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-007` — confirmReset slices the token identifier without validating its prefix, turning a valid verify-email token into a 500](low/ARF-007-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-008` — Reset works for unverified accounts (good) but completing a reset neither confers nor requires verification, leaving the account still locked](low/ARF-008-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-010` — Reset-request rate limit is keyed solely on the attacker-chosen email — unlimited spray across addresses](low/ARF-010-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`AR-001` — Documented MFA step-up flow has no attachment point: nothing hooks session issuance](high/AR-001-aeneas-rekkas.md) `_(aeneas-rekkas, high)_`
- … 41 more findings touch `packages/password/src/Password.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `verification-token-delivery`. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:271`. Fix: Replace the userId in token identifiers with a random public id; recover userId from the consumed VerificationTokenView. (effort S). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Tokens are <purpose>:<publicId>.<secret> with a 128-bit random base64url publicId; userId is recovered from the consumed row (Option.none -> TokenConsumed) and rate-limit keys use the publicId. Tests (red first): PasswordMail.test.ts ('reset and verify mail tokens do not contain the userId'); VerificationLink.test.ts. Trade-off noted: a re-request no longer supersedes an earlier undelivered token for the same user (old tokens live until expiry); a per-user invalidation would need a Verification API addition (not done).
