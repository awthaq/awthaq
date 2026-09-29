---
ID: "RBS-005"
Title: "HIBP check treats any non-throwing response as authoritative — a 429/5xx body silently counts as 'not breached'"
Level: medium
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:216"
Auditor: "rate-limiting-brute-force-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RBS-005 — HIBP check treats any non-throwing response as authoritative — a 429/5xx body silently counts as 'not breached'

`MEDIUM` · `security` · `password` · reported by **Rate Limiting & Brute-Force Defense Specialist** (`rate-limiting-brute-force-specialist`)

Status: **resolved**

## Summary

In Effect v4, HttpClient.get only fails on transport errors — non-2xx statuses resolve normally unless filterStatusOk/filterStatus is applied (verified in effect@4.0.0-rc.116 HttpClient.ts). isBreached therefore parses the error body of a rate-limited (pwnedpasswords throttles aggressively) or 5xx response, finds no suffix match, and returns false = 'not breached', never reaching the configured onUnavailable allow/reject policy that only guards the catch path. An operator who explicitly opted into fail-closed breach checking (breachCheck: { onUnavailable: "reject" }) gets fail-open behavior precisely under the degraded-provider conditions the option exists for. Mitigated by breachCheck defaulting to false (Password.ts:42).

## Evidence

Source: `packages/password/src/Password.ts:216`

```
const body = yield* response.text;
    return body.split("\n").some((line) => line.split(":")[0]?.trim().toUpperCase() === suffix);
```

## Recommended fix

Check response.status before parsing (fail into the onUnavailable branch for any non-2xx, or use HttpClient.filterStatusOk at the call site), and consider treating an empty/garbled body the same way.

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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `password-policy-posture`. Already fixed by commit 25d991e. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:316`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
