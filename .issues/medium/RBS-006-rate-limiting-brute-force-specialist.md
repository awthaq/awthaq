---
ID: "RBS-006"
Title: "Registry metadata has already drifted from enforced keys (and two registered keys embed full request payloads)"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "password"
Source: "packages/password/src/Password.ts:402"
Auditor: "rate-limiting-brute-force-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RBS-006 — Registry metadata has already drifted from enforced keys (and two registered keys embed full request payloads)

`MEDIUM` · `correctness` · `password` · reported by **Rate Limiting & Brute-Force Defense Specialist** (`rate-limiting-brute-force-specialist`)

Status: **ready-for-agent**

## Summary

Enforcement and registration are maintained by hand as two parallel lists, and they already disagree: the registered signIn key uses raw input.email (Password.ts:402) while the enforced key lowercases (Password.ts:517), so `Alice@x.com` and `alice@x.com` are two registry keys but one enforced bucket. Worse, confirmReset and changePassword register `JSON.stringify(input)` (Password.ts:416, 423) as their key — which is neither the enforced key (decoded identifier / userId, lines 629 and 698) nor safe as a key spec, since stringifying the input would fold the reset token and password material into a bucket key. Because the registry is introspection-only today, an operator reading registered() gets a misleading picture of exactly the throttling posture this domain exists to make legible (BEH-EA-111).

## Evidence

Source: `packages/password/src/Password.ts:402`

```
key: (input) => `password:signin:${(input as { readonly email: string }).email}`,
```

## Recommended fix

Make the registry the single source of truth: pass the registered key function to consume at enforcement time so one definition feeds both, which also forces the key functions to be secret-safe and consistent by construction.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: brute-force defense
- Full dossier: [`rate-limiting-brute-force-specialist`](../../.reports/rate-limiting-brute-force-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-rate-limit-hardening`. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:581`. Fix: Make one typed rule definition feed both the registry and enforcement; key functions never see secrets. (effort M). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.
