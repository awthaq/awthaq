---
ID: "ESS-005"
Title: "Rate-limit key derivation uses bare casts 60 lines after the same file forbids them"
Level: medium
Category: "dx"
Status: ready-for-agent
Package: "password"
Source: "packages/password/src/Password.ts:397"
Auditor: "effect-schema-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-005 — Rate-limit key derivation uses bare casts 60 lines after the same file forbids them

`MEDIUM` · `dx` · `password` · reported by **Effect Schema Specialist** (`effect-schema-specialist`)

Status: **ready-for-agent**

## Summary

Lines 131-140 of this same file document that 'this repo forbids as/as unknown as/as any in library source' and build emailFromRateLimitInput as the honest narrowing check — then lines 397, 402, and 408 cast the untyped RateLimits.RateLimitKey input with `(input as { readonly email: string }).email` for signUp/signIn/requestReset anyway, and only resendVerification (line 428) uses the safe helper. RateLimitKey's input is declared unknown, so a middleware wiring change that passes a different shape turns these keys into runtime TypeErrors on the enforcement path.

## Evidence

Source: `packages/password/src/Password.ts:397`

```
key: (input) => `password:signup:${(input as { readonly email: string }).email}`,
```

## Recommended fix

Use emailFromRateLimitInput in all four rules, or better, type RateLimitKey's input generically against the endpoint payload schema so the narrowing check and the cast both disappear.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Schema discipline
- Full dossier: [`effect-schema-specialist`](../../.reports/effect-schema-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-rate-limit-hardening`. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:571`. Fix: Remove the three casts — delivered by RBS-006's single-source rule definitions (schema-decoded registry keys). (effort S). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.
