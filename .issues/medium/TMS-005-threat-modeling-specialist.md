---
ID: "TMS-005"
Title: "signUp responds EmailAlreadyExists — account enumeration inconsistent with the plugin's own anti-enumeration posture"
Level: medium
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:482"
Auditor: "threat-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TMS-005 — signUp responds EmailAlreadyExists — account enumeration inconsistent with the plugin's own anti-enumeration posture

`MEDIUM` · `security` · `password` · reported by **Threat Modeling Specialist** (`threat-modeling-specialist`)

Status: **resolved**

## Summary

The same file works hard to be enumeration-safe elsewhere — requestReset and resendVerification return identical 202s for known and unknown emails (Password.ts:574-577, 599-602), and signIn burns a real hash on a dummy credential (Password.ts:447, 527-532) — yet signUp surfaces a distinct EmailAlreadyExists error (status-mapped in PasswordApi.ts:148), and its timing additionally separates the paths (existing email fails fast after the policy check; new email pays argon2 + link + session issue). An attacker can harvest registered addresses at will; because an unverified signup squats the address, this feeds directly into the pre-takeover scenario in TMS-007.

## Evidence

Source: `packages/password/src/Password.ts:482`

```
        const user = yield* users.create({ email: input.email, name }).pipe(
          Effect.catchTag("EmailAlreadyExists", () => new PasswordApi.EmailAlreadyExists()),
```

## Recommended fix

Decide the posture explicitly: either return the same success-shaped response for both branches (send 'you already have an account' mail instead), or document the enumeration trade-off as an accepted product decision in spec so the inconsistency with requestReset is at least intentional.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-policy-posture`. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:745`. Fix: Implement the chosen posture; at minimum record the exception in spec. (effort M). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option C per plan; user may revisit. PasswordConfig.signUpEnumeration reveal|conceal (default reveal). Conceal: signUpConcealed answers 202/no session for fresh and existing address alike (hash computed in both branches), fresh gets verify-email, existing owner gets account-exists; contract success is [SessionDto, Empty(202)]. ADR-EA-026 (spec/decisions/026-signup-enumeration-posture.md; numbered 026 to avoid the numbers other plans reserve) + BEH-EA-086 note. Tests: AuthHttp.test.ts (conceal indistinguishable, weak password still 422).
