---
ID: "TMS-008"
Title: "confirmReset consumes the token outside any transaction — INV-EA-009's in-transaction requirement unmet by its flagship caller"
Level: low
Category: "docs"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:630"
Auditor: "threat-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TMS-008 — confirmReset consumes the token outside any transaction — INV-EA-009's in-transaction requirement unmet by its flagship caller

`LOW` · `docs` · `password` · reported by **Threat Modeling Specialist** (`threat-modeling-specialist`)

Status: **resolved**

## Summary

INV-EA-009 specifies the token be consumed 'inside the same transaction as the state change it authorizes', and Verification.ts's header (lines 21-24) claims the calling plugin 'wraps consume together with its own state change' via SqlTransaction. confirmReset does not: consume (line 630) and updateCredentialHash (line 657) are independent effects, with a policy check and hasher work between them. Replay is still structurally impossible (consume is atomic in both layers), so the security core holds, but a crash or failure after consume leaves the reset token burnt with the password unchanged — the user must request a fresh reset. OAuth's create+link path (OAuth.ts:682-717) does wrap correctly, making the password plugin the outlier against its own spec.

## Evidence

Source: `packages/password/src/Password.ts:630`

```
        yield* verification.consume(identifier, value).pipe(
          Effect.catchTag("TokenConsumed", () => new PasswordApi.TokenConsumed()),
```

## Recommended fix

Wrap confirmReset's consume + updateCredentialHash (+ revokeAll) in SqlTransaction.withTransaction the way OAuth links do, or amend INV-EA-009/BEH-EA-058 to state the weaker single-use guarantee the code actually provides.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: STRIDE threat model
- Full dossier: [`threat-modeling-specialist`](../../.reports/threat-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `password-recovery-correctness`. Already fixed by commit 34caae8. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:986`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
