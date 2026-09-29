---
ID: "CSD-008"
Title: "Password change does not revoke other sessions — attacker-held sessions survive credential rotation"
Level: medium
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:727"
Auditor: "credential-stuffing-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSD-008 — Password change does not revoke other sessions — attacker-held sessions survive credential rotation

`MEDIUM` · `security` · `password` · reported by **Credential Stuffing Defense Specialist** (`credential-stuffing-defense-specialist`)

Status: **resolved**

## Summary

confirmReset correctly revokes everything (sessions.revokeAll at line 664, with the comment noting 'every session, no exceptions'), but the authenticated changePassword path ends at updating the credential hash with no revocation. For ATO containment this is the wrong default asymmetry: the realistic recovery story after a stuffing compromise is 'reset via email' (covered), but a victim who still has access and changes their password — or rotates it proactively after a breach notice — evicts nobody. OWASP session-management guidance recommends invalidating existing sessions after a password change.

## Evidence

Source: `packages/password/src/Password.ts:727`

```
const hash = yield* hasher.hash(input.newPassword);
        yield* accounts.updateCredentialHash(account.id, Redacted.make(hash)).pipe(Effect.orDie);
      });
```

## Recommended fix

Revoke other sessions (keeping the caller's current one, mirroring the revokeOthers semantics the confirmReset comment says preceded revokeAll) after a successful changePassword, or at minimum return the new session list so clients can offer eviction.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: credential stuffing defense
- Full dossier: [`credential-stuffing-defense-specialist`](../../.reports/credential-stuffing-defense-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `password-recovery-correctness`. Already fixed by commit 2761e8d. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:1137`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
