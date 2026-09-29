---
ID: "TMS-006"
Title: "Signup spam and verification-mail bombing via subaddressed aliases — per-email rate keys normalize case only"
Level: medium
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:471"
Auditor: "threat-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TMS-006 — Signup spam and verification-mail bombing via subaddressed aliases — per-email rate keys normalize case only

`MEDIUM` · `security` · `password` · reported by **Threat Modeling Specialist** (`threat-modeling-specialist`)

Status: **resolved**

## Summary

Every signup dispatches a verification email to an arbitrary address via forkDetach (Password.ts:501-511), and the only throttle is 5/hour keyed on lowercased email — no IP dimension anywhere in the plugin (a decision documented at Password.ts:142-154 but with no follow-up mechanism built). Providers that support subaddressing deliver victim+1@, victim+2@, … all to one inbox while Users/emails treats them as distinct addresses (only toLowerCase, Users.ts:110), so N aliases × 5/hour gives an unbounded mail-bombing rate against a single mailbox, plus unlimited account-row creation (signup spam) in the users table. The same aliasing defeats the signIn/requestReset per-email caps for distributed credential stuffing.

## Evidence

Source: `packages/password/src/Password.ts:471`

```
        yield* rateLimit(`password:signup:${input.email.toLowerCase()}`, RATE_LIMITS.signUp);
```

## Recommended fix

Normalize subaddressing (strip '+tag' for the rate-limit key, keep the literal email for delivery), add an IP-based second dimension to the signUp/requestReset rules once client-IP extraction exists, and consider a per-IP signup cap in the default rule set.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `password-rate-limit-hardening`. Already fixed by commit a3b7255. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:715`. Fix: Normalize subaddressed emails for every per-email rate-limit key (delivery keeps the literal address). (effort S). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Per-email rate keys normalize case and a +tag (defaultEmailRateKey), configurable via PasswordConfig.rateLimitEmailKey, for signUp/signIn/requestReset/resendVerification; delivery keeps the literal address. Tests: PasswordRateLimits.test.ts (victim+1..6@x.com share one bucket; custom key fn).
