---
ID: "TSS-007"
Title: "signUp EmailAlreadyExists is an explicit account-existence oracle, undocumented as an exception to BEH-EA-086"
Level: low
Category: "docs"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:482"
Auditor: "timing-side-channel-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TSS-007 — signUp EmailAlreadyExists is an explicit account-existence oracle, undocumented as an exception to BEH-EA-086

`LOW` · `docs` · `password` · reported by **Timing / Side-Channel Specialist** (`timing-side-channel-specialist`)

Status: **resolved**

## Summary

BEH-EA-086 (spec/behaviors/11-http-error-mapping.md:120) extends uniform enumeration-safety to "every endpoint the composed auth.api exposes", yet signUp returns 409 EmailAlreadyExists — a direct, intentional existence oracle. Registration-time duplicate-email disclosure is a widely accepted UX tradeoff (it also enables unlimited unauthenticated registration probing of the address space, subject only to the 5/hour signUp limit), but the spec nowhere records it as the accepted exception it visibly is, and the HIBP check ordering (checkPolicy before users.create, line 471-482) at least ensures the leak is not amplified by timing. Flagging so the decision is explicit rather than accidental.

## Evidence

Source: `packages/password/src/Password.ts:482`

```
Effect.catchTag("EmailAlreadyExists", () => new PasswordApi.EmailAlreadyExists()),
```

## Recommended fix

Add a short decision note (spec/decisions/ or a comment citing it) marking EmailAlreadyExists-at-signUp as the deliberate exception to BEH-EA-086, with the rate limit named as the compensating control; alternatively offer a config toggle for silent-accept-with-email behavior.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: timing side channels
- Full dossier: [`timing-side-channel-specialist`](../../.reports/timing-side-channel-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `password-policy-posture`. Duplicate of `TMS-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:748`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `TMS-005-threat-modeling-specialist` — closed by its fix (see that issue's Resolved comment).
