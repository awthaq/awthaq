---
ID: "ARF-010"
Title: "Reset-request rate limit is keyed solely on the attacker-chosen email — unlimited spray across addresses"
Level: low
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:407"
Auditor: "account-recovery-flow-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ARF-010 — Reset-request rate limit is keyed solely on the attacker-chosen email — unlimited spray across addresses

`LOW` · `security` · `password` · reported by **Account Recovery Flow Specialist** (`account-recovery-flow-specialist`)

Status: **resolved**

## Summary

The 5-per-15-minutes requestReset bucket is keyed on the submitted email alone (line 570 lower-cases it, matching the lower(email) lookup), so an attacker rotating N addresses gets N fresh buckets — an unthrottled reset-mail spray for mail-bombing and for amplifying any residual latency oracle. BEH-EA-108's own traceability row warns that 'keying on an attacker-chosen value makes the limiter's bucket space attacker-controlled' (REQ-EA-294); the shipped rules embrace exactly that shape on every email-keyed endpoint.

## Evidence

Source: `packages/password/src/Password.ts:407`

```
endpoint: "requestReset",
              key: (input) =>
                `password:reset-request:${(input as { readonly email: string }).email}`,
```

## Recommended fix

Compose a second, coarser dimension the application controls (IP or global bucket) alongside the per-email rule, or document that deployments must front the endpoint with an edge limiter; register the composite rule through the existing RateLimits registry.

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
- [`ARF-009` — Mailed reset token embeds the internal userId, leaking a UUIDv7 (creation timestamp) inside a recovery artifact](low/ARF-009-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`AR-001` — Documented MFA step-up flow has no attachment point: nothing hooks session issuance](high/AR-001-aeneas-rekkas.md) `_(aeneas-rekkas, high)_`
- … 41 more findings touch `packages/password/src/Password.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `password-rate-limit-hardening`. Already fixed by commit a3b7255. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:884`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
