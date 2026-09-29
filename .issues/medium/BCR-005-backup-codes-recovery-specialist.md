---
ID: "BCR-005"
Title: "Verification.issue mints its own 256-bit hex value, leaving no way to issue caller-formatted codes"
Level: medium
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/Verification.ts:152"
Auditor: "backup-codes-recovery-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BCR-005 — Verification.issue mints its own 256-bit hex value, leaving no way to issue caller-formatted codes

`MEDIUM` · `security` · `core` · reported by **Backup Codes & Account Recovery Specialist** (`backup-codes-recovery-specialist`)

Status: **resolved**

## Summary

issue always generates the token value itself as 32 random bytes hex-encoded — a 64-character string no user can type. Backup codes need a human-format set (research/07 Q58: 10 codes, 12 chars a-z0-9, ~71 bits). A two-factor plugin must either bend identifiers to carry hashes of self-generated codes ('backup-code:<userId>:<codeHash>') or Verification must grow a caller-supplied-value issue variant; neither is designed yet, and the identifier-prefix purpose convention (BEH-EA-057) does not cover code-hash identifiers.

## Evidence

Source: `packages/core/src/Verification.ts:152`

```
        const value = toHex(yield* crypto.randomBytes(32));
        const valueHash = yield* hash(value);
```

## Recommended fix

Decide the scheme up front: prefer per-code identifiers of the form 'backup-code:<userId>:<sha256(code)>' reusing Verification's own hashing for lookup, or add issueWithValue that hashes a caller-supplied Redacted value under the same single-use consume semantics.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: Backup Codes & Recovery
- Full dossier: [`backup-codes-recovery-specialist`](../../.reports/backup-codes-recovery-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-002` — Verification token digest compared with !== instead of constant-time equality](low/ACS-002-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`APS-003` — Unthrottled /verify-email plus replay-per-miss floods the bounded AuthEvents PubSub](high/APS-003-auth-pentest-specialist.md) `_(auth-pentest-specialist, high)_`
- [`BCR-008` — Show-once primitive already exists: issue returns the plaintext value exactly once as Redacted](info/BCR-008-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, info)_`
- [`CSG-003` — No retention sweep: expired sessions and consumed/expired verification rows persist forever](high/CSG-003-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`ECF-008` — Memory layers never reap expired state: reservations, sessions, and tokens grow unboundedly](medium/ECF-008-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, medium)_`
- [`MLO-002` — Verification.reserve - the domain-level resend/serialization primitive - has zero production callers](medium/MLO-002-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, medium)_`
- [`MLO-004` — Token-secret comparison is not constant time, diverging from the codebase's own BEH-EA-056 posture](low/MLO-004-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, low)_`
- [`SOS-004` — Verification.consume enforces no attempt budget — unlimited guesses against a live token, safe only while codes are 256-bit](medium/SOS-004-sms-otp-specialist.md) `_(sms-otp-specialist, medium)_`
- … 3 more findings touch `packages/core/src/Verification.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence medium); workstream `verification-otp-substrate`. Evidence at HEAD ec065a7: `packages/core/src/Verification.ts:158`. Fix: Let Verification.issue mint caller-formatted values via a typed generator option (never a raw caller string), keeping hashing and single-use semantics. (effort M). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Verification.issue mints the value itself: format {_tag: Numeric, digits} (4-10 digits, rejection sampling over Crypto.randomBytes), never a caller string; type requires maxAttempts for a numeric value; hashing and single use unchanged. Tests: packages/core/test/Verification.test.ts (memory + SQL). BEH-EA-057/244.
