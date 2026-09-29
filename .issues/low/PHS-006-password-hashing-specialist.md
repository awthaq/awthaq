---
ID: "PHS-006"
Title: "Breach screening fully implemented but disabled by default"
Level: low
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:41"
Auditor: "password-hashing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PHS-006 — Breach screening fully implemented but disabled by default

`LOW` · `security` · `password` · reported by **Password Hashing Specialist** (`password-hashing-specialist`)

Status: **resolved**

## Summary

The k-anonymity implementation is correct (5-char SHA-1 prefix leaves the process, case-insensitive suffix match, tested for breached/fail-open/fail-closed in Password.test.ts:411-479), but defaultPasswordConfig ships breachCheck: false, so a deployment that never reads the docs gets no breached-password screening on signUp, confirmReset, or changePassword - diverging from OWASP's recommendation to screen new passwords against breach corpora. BEH-EA-119 requires the default posture be 'documented, not silently chosen'; the code documents the knob but the secure path is the opt-in one.

## Evidence

Source: `packages/password/src/Password.ts:41`

```
minLength: 12,
  breachCheck: false,
  resetTtl: Duration.hours(1),
```

## Recommended fix

Either flip the default to breachCheck: true (fail-open, matching BEH-EA-119's own example posture) so screening is on unless declined, or keep false but surface the choice in the plugin's README/quickstart with the OWASP rationale; either way ensure an unreachable provider degrades gracefully per the existing onUnavailable policy.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Password hashing
- Full dossier: [`password-hashing-specialist`](../../.reports/password-hashing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 6 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-policy-posture`. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:44`. Fix: After the decision: flip (B) or document (A). (effort S). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option B per plan; user may revisit. defaultPasswordConfig.breachCheck is now true (fail-open, 3s timeout, breachCheck:false opts out); BEH-EA-119 text, README quickstart and config note updated. Test: PasswordPolicy.test.ts (default config rejects a breached password; opt-out works). Test compositions use a well-formed non-matching range body.
