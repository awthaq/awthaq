---
ID: "TSS-005"
Title: "Verification.consume compares valueHash with plain !==, inconsistent with repo constant-time standard"
Level: low
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/Verification.ts:196"
Auditor: "timing-side-channel-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TSS-005 — Verification.consume compares valueHash with plain !==, inconsistent with repo constant-time standard

`LOW` · `security` · `core` · reported by **Timing / Side-Channel Specialist** (`timing-side-channel-specialist`)

Status: **resolved**

## Summary

The presented secret's SHA-256 hex is compared to the stored hash with !==, and the SQL layer delegates the same equality to a WHERE clause (repo.tryConsume, Verification.ts:299). Because both operands are digests and the underlying secret is 256-bit random (Verification.ts:152), exploiting the prefix-match timing oracle requires SHA-256 preimage work, so this is defense-in-depth rather than a practical break. But it is exactly the pattern the repo's own comment condemns: packages/ports/src/PasswordHasher.ts:66-68 states an "ordinary === on the digest would leak timing information a constant-time comparison is specifically meant to deny", and Sessions.ts:289-292 uses constantTimeEqual for the identical digest-vs-digest comparison. One of the two postures is wrong by the codebase's own written standard.

## Evidence

Source: `packages/core/src/Verification.ts:196`

```
Option.isNone(row) ||
isExpired(row.value, now) ||
row.value.valueHash !== presentedHash
```

## Recommended fix

Reuse the shared constantTimeEqual helper (see TSS-003) for the memory layer's comparison; for the SQL layer, return the candidate row and compare the digest in application code, or accept and document the DB-side equality as a deliberate exception.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: timing side channels
- Full dossier: [`timing-side-channel-specialist`](../../.reports/timing-side-channel-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-002` — Verification token digest compared with !== instead of constant-time equality](low/ACS-002-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`APS-003` — Unthrottled /verify-email plus replay-per-miss floods the bounded AuthEvents PubSub](high/APS-003-auth-pentest-specialist.md) `_(auth-pentest-specialist, high)_`
- [`BCR-005` — Verification.issue mints its own 256-bit hex value, leaving no way to issue caller-formatted codes](medium/BCR-005-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, medium)_`
- [`BCR-008` — Show-once primitive already exists: issue returns the plaintext value exactly once as Redacted](info/BCR-008-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, info)_`
- [`CSG-003` — No retention sweep: expired sessions and consumed/expired verification rows persist forever](high/CSG-003-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`ECF-008` — Memory layers never reap expired state: reservations, sessions, and tokens grow unboundedly](medium/ECF-008-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, medium)_`
- [`MLO-002` — Verification.reserve - the domain-level resend/serialization primitive - has zero production callers](medium/MLO-002-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, medium)_`
- [`MLO-004` — Token-secret comparison is not constant time, diverging from the codebase's own BEH-EA-056 posture](low/MLO-004-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, low)_`
- … 3 more findings touch `packages/core/src/Verification.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `verification-hardening`. Duplicate of `ACS-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Verification.ts:202`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `ACS-002-applied-cryptography-specialist` — closed by its fix (see that issue's Resolved comment).
