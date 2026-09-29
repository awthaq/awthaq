---
ID: "FAMS-003"
Title: "Hard emailVerified sign-in gate diverges from Firebase semantics and locks out migrated users"
Level: medium
Category: "correctness"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:548"
Auditor: "firebase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# FAMS-003 — Hard emailVerified sign-in gate diverges from Firebase semantics and locks out migrated users

`MEDIUM` · `correctness` · `password` · reported by **Firebase Auth Migration Specialist** (`firebase-auth-migration-specialist`)

Status: **resolved**

## Summary

effect-auth treats an unverified email as an absolute bar to password sign-in. Firebase never blocks sign-in on email_verified — it is an informational claim apps choose to enforce. A Firebase population imported wholesale includes many users who signed in for years without ever verifying; in effect-auth they all fail with EmailNotVerified until they complete the new system's emailed verification flow, a forced-friction outcome the persona's own red flags warn against (forced reset-style migration). There is no admin HTTP surface to set emailVerified, though importers can call Users.verifyEmail server-side for users Firebase marked verified (packages/core/src/Users.ts:66).

## Evidence

Source: `packages/password/src/Password.ts:548`

```
if (!user.emailVerified) {
  return yield* Effect.fail(new PasswordApi.EmailNotVerified());
}
```

## Recommended fix

During import, call Users.verifyEmail for every Firebase user with email_verified=true. For the rest, either soften the gate behind PasswordConfig (flag-first with a warning) or accept the gate as deliberate policy and document it as a required migration communication step.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Firebase migration parity
- Full dossier: [`firebase-auth-migration-specialist`](../../.reports/firebase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-policy-posture`. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:841`. Fix: Make the verified-email sign-in gate configurable (default unchanged) and document the migration step. (effort S). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** PasswordConfig.requireVerifiedEmail (default true; the gate is still applied only after credentials verify). Docs in BEH-EA-114 text and migrate-auth0/-firebase/-better-auth READMEs. Tests: PasswordPolicy.test.ts.
