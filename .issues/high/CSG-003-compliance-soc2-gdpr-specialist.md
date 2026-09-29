---
ID: "CSG-003"
Title: "No retention sweep: expired sessions and consumed/expired verification rows persist forever"
Level: high
Category: "compliance"
Status: resolved
Package: "core"
Source: "packages/core/src/Verification.ts:287"
Auditor: "compliance-soc2-gdpr-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSG-003 — No retention sweep: expired sessions and consumed/expired verification rows persist forever

`HIGH` · `compliance` · `core` · reported by **Compliance (SOC2/GDPR) Specialist** (`compliance-soc2-gdpr-specialist`)

Status: **resolved**

## Summary

Consumed verification rows are kept by design ('Already-consumed history is never touched'), expired-but-unconsumed rows also persist (08-verification-tokens.feature pins that a read rejects an expired token 'even though the row has not been physically deleted'), and expired session rows are merely rejected at verify (Sessions.ts:484-491) with no deletion path. A repo-wide grep for purge/sweep/cleanup/retention returns zero production hits. Session rows carry ipAddress and userAgent, so personal data is stored without any bound on duration, failing GDPR Art. 5(1)(e) storage limitation; SessionConfig's 30-day absolute expiry bounds validity, not storage.

## Evidence

Source: `packages/core/src/Verification.ts:287`

```
      // a single statement. Already-consumed history is never touched.
```

## Recommended fix

Add a scheduled sweep (e.g. a daily Effect schedule in the composition root) that deletes sessions past absoluteExpiresAt plus a grace window and verification rows consumed or expired older than a documented forensic window, and expose it as a repository operation so operators can also run it from cron.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: Compliance & Data Protection
- Full dossier: [`compliance-soc2-gdpr-specialist`](../../.reports/compliance-soc2-gdpr-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 28 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-002` — Verification token digest compared with !== instead of constant-time equality](low/ACS-002-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`APS-003` — Unthrottled /verify-email plus replay-per-miss floods the bounded AuthEvents PubSub](high/APS-003-auth-pentest-specialist.md) `_(auth-pentest-specialist, high)_`
- [`BCR-005` — Verification.issue mints its own 256-bit hex value, leaving no way to issue caller-formatted codes](medium/BCR-005-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, medium)_`
- [`BCR-008` — Show-once primitive already exists: issue returns the plaintext value exactly once as Redacted](info/BCR-008-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, info)_`
- [`ECF-008` — Memory layers never reap expired state: reservations, sessions, and tokens grow unboundedly](medium/ECF-008-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, medium)_`
- [`MLO-002` — Verification.reserve - the domain-level resend/serialization primitive - has zero production callers](medium/MLO-002-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, medium)_`
- [`MLO-004` — Token-secret comparison is not constant time, diverging from the codebase's own BEH-EA-056 posture](low/MLO-004-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, low)_`
- [`SOS-004` — Verification.consume enforces no attempt budget — unlimited guesses against a live token, safe only while codes are 256-bit](medium/SOS-004-sms-otp-specialist.md) `_(sms-otp-specialist, medium)_`
- … 3 more findings touch `packages/core/src/Verification.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Data retention sweep & GDPR erasure cascade](../../.scratch/resolve-ready-for-human-findings/issues/30-data-retention-gdpr-erasure.md) — adds a `Retention.sweep` domain service (bulk-delete expired sessions/verification rows via new cutoff-based repository primitives), config-as-service default windows, and an opt-in scheduled `Layer` an operator can enable. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — Evidence quote matches `packages/core/src/Verification.ts:287` verbatim. `Sessions.ts:483-491` confirms expired rows are rejected at verify with no delete path, and a repo-wide grep for purge/sweep/cleanup/retention in `packages/*/src` returns only one unrelated comment (`packages/server/src/Authentication.ts:121`). No sweep mechanism exists anywhere. Deciding the forensic/retention window length is a compliance-policy judgment call, not a mechanical fix. Status → ready-for-human.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `data-retention-sweep`. Evidence at HEAD ec065a7: `packages/core/src/Verification.ts:300`. Fix: Implement ticket 30's Retention service: cutoff-based purge primitives on both Sessions and Verification (both layers), a RetentionConfig reference, Retention.sweep, and an opt-in Retention.layerScheduled. (effort L). Full dossier: `.plan/slices/01-core-sessions-users.md`.

**Resolved (2026-09-29):** Implemented ticket 30's Retention (ADR-EA-031). Purge primitives on both layers: Sessions.purgeExpired(before) (absolute or idle expiry before the cutoff, tombstoned rows included) and Verification.purgeExpired(before) (tokens consumed or expired before it plus expired reservations); the memory layers filter their maps with one Ref.modify, the SQL layers loop bounded `DELETE ... WHERE id IN (SELECT ... LIMIT n) RETURNING` statements via new repository ops deleteExpiredBefore on SessionsRepository, VerificationRepository and VerificationReservationsRepository (packages/sql/src/Repositories.ts), so a big backlog is a run of short transactions, not one long lock. New packages/core/src/Retention.ts: RetentionConfig Reference (sessionGrace 7d, verificationForensicWindow 90d, sweepInterval 1d, auditLog), Retention.config(partial), Retention.sweep returning {sessionsDeleted, verificationRowsDeleted, auditRowsDeleted}, opt-in Retention.layerScheduled (sweeps at start-up then every interval; a failed sweep is logged, never fatal; NOT included by Auth.make/TestAuth). Tests: packages/core/test/Retention.test.ts runs the same suite over memory and SQLite (TestClock; grace/forensic windows, live rows kept, idempotence, scheduled layer inert until provided) plus SQL-only proof that the rows are physically gone; packages/sql/test/contract.ts has the repository cases (bounded batches, counts) on every dialect. examples/memory-server opts in with Retention.layerScheduled. Spec: As-shipped paragraphs on BEH-EA-051 (07-sessions), BEH-EA-061 (08-verification-tokens), BEH-EA-100 (13-events), ADR-EA-031, README 'Retention'. Deviation from the dossier: no new BEH ids, the behaviors are documented as As-shipped paragraphs on the existing ones (keeps ids contiguous across concurrent programs); the 08-verification-tokens.feature scenario 'row has not been physically deleted' stays true as written (it is about the moment before any sweep). The default windows are a compliance policy the operator confirms, as the dossier flags.
