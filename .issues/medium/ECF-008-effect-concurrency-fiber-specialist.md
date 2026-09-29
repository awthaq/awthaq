---
ID: "ECF-008"
Title: "Memory layers never reap expired state: reservations, sessions, and tokens grow unboundedly"
Level: medium
Category: "performance"
Status: resolved
Package: "core"
Source: "packages/core/src/Verification.ts:143"
Auditor: "effect-concurrency-fiber-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECF-008 — Memory layers never reap expired state: reservations, sessions, and tokens grow unboundedly

`MEDIUM` · `performance` · `core` · reported by **Effect Concurrency & Fiber Specialist** (`effect-concurrency-fiber-specialist`)

Status: **resolved**

## Summary

reserve() overwrites live reservations but nothing ever removes expired keys from this map; likewise the Sessions memory HashMap and the Verification token map only delete on explicit revoke/consume, never on expiry. No background reaper, daemon, or maintenance fiber exists anywhere in the runtime (verified: zero prunes/sweeps/reapers in packages/, and the example server is a plain HttpRouter.serve with no loops). In long-lived memory-backed deployments — the shipped examples/memory-server default — every distinct identifier ever reserved, and every session until revocation, is retained for process lifetime, and identifiers are partly attacker-controlled (e.g. per-email rate keys, verification identifiers), making this a slow memory-growth vector.

## Evidence

Source: `packages/core/src/Verification.ts:143`

```
const reservations = yield* Ref.make(HashMap.empty<string, DateTime.Utc>());
```

## Recommended fix

Either schedule a scope-bound maintenance fiber per memory layer (Effect.forkScoped + periodic Ref.update pruning on expiry — the natural home for this codebase's first deliberate daemon) or enforce a max-size with oldest-expired eviction on the reservation map; document that memory layers are not for unbounded production tenancy.

## Context

- Auditor verdict on this domain: **needs-work** (score 68/100), domain: Concurrency & Fibers
- Full dossier: [`effect-concurrency-fiber-specialist`](../../.reports/effect-concurrency-fiber-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-002` — Verification token digest compared with !== instead of constant-time equality](low/ACS-002-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`APS-003` — Unthrottled /verify-email plus replay-per-miss floods the bounded AuthEvents PubSub](high/APS-003-auth-pentest-specialist.md) `_(auth-pentest-specialist, high)_`
- [`BCR-005` — Verification.issue mints its own 256-bit hex value, leaving no way to issue caller-formatted codes](medium/BCR-005-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, medium)_`
- [`BCR-008` — Show-once primitive already exists: issue returns the plaintext value exactly once as Redacted](info/BCR-008-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, info)_`
- [`CSG-003` — No retention sweep: expired sessions and consumed/expired verification rows persist forever](high/CSG-003-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`MLO-002` — Verification.reserve - the domain-level resend/serialization primitive - has zero production callers](medium/MLO-002-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, medium)_`
- [`MLO-004` — Token-secret comparison is not constant time, diverging from the codebase's own BEH-EA-056 posture](low/MLO-004-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, low)_`
- [`SOS-004` — Verification.consume enforces no attempt budget — unlimited guesses against a live token, safe only while codes are 256-bit](medium/SOS-004-sms-otp-specialist.md) `_(sms-otp-specialist, medium)_`
- … 3 more findings touch `packages/core/src/Verification.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `data-retention-sweep`. Duplicate of `CSG-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Verification.ts:151`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.
