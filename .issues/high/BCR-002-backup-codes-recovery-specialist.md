---
ID: "BCR-002"
Title: "No bulk-invalidate, list, or count primitives anywhere in the Verification stack"
Level: high
Category: "architecture"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:586"
Auditor: "backup-codes-recovery-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BCR-002 — No bulk-invalidate, list, or count primitives anywhere in the Verification stack

`HIGH` · `architecture` · `sql` · reported by **Backup Codes & Account Recovery Specialist** (`backup-codes-recovery-specialist`)

Status: **resolved**

## Summary

VerificationRepositoryShape exposes only insert/findByIdentifier/upsertLive/tryConsume, and VerificationShape only issue/consume/reserve. Regenerating a backup-code set requires wholesale invalidation of ~10 old rows that the plugin can never consume (it never sees their values), and the persona's low-remaining-codes warnings require a live-row count. Neither operation has any foundation at the repository or service level; Accounts and Sessions got raw bulk statements (deleteAllByUser, deleteAllForUserExcept) but Verification did not. Implemented naively, regeneration would either leak old live codes or delete-before-insert — the persona's own red flag — instead of one transaction per BEH-EA-058.

## Evidence

Source: `packages/sql/src/Repositories.ts:586`

```
      findByIdentifier,
      upsertLive,
      tryConsume,
```

## Recommended fix

Before Phase 2, add deleteAllByIdentifierPrefix (or a setId column) and countLiveByIdentifierPrefix to VerificationRepositoryShape, plus an invalidateSet operation on VerificationShape, and require regeneration to run delete-old + insert-new inside one SqlClient.withTransaction.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: Backup Codes & Recovery
- Full dossier: [`backup-codes-recovery-specialist`](../../.reports/backup-codes-recovery-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`DRS-005` — Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding](medium/DRS-005-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ERAS-006` — SQL repositories are structurally driver-neutral, but no edge-viable SqlClient story exists or is documented](info/ERAS-006-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`EOTS-008` — Hand-written SQL queries bypass the spanPrefix spans that repository CRUD gets](medium/EOTS-008-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`ESR-001` — AccountsRepository.update is a non-transactional read-modify-write that can lose concurrently refreshed tokens](medium/ESR-001-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-003` — Email case-folding relies on lower() whose semantics diverge between SQLite and Postgres and from the app-level normalization](medium/ESR-003-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-004` — Decrypt failures are collapsed to fiber defects, so one unreadable row poisons whole result-set operations](medium/ESR-004-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-005` — findByIdentifier cannot use the identifier index for consumed history and sorts unindexed](low/ESR-005-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- [`ESR-007` — verifyEmail hardcodes the bit literal 1 instead of the model's BooleanFromBit encoding](low/ESR-007-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- … 19 more findings touch `packages/sql/src/Repositories.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/sql/src/Repositories.ts:586-588` matches (`findByIdentifier, upsertLive, tryConsume`), and `VerificationRepositoryShape`/`VerificationShape` (core/src/Verification.ts:89+) expose only `issue`/`consume`/`reserve` — no bulk-invalidate, list, or count. `Accounts`/`Sessions` repositories already have `deleteAllByUser`/`deleteAllForUserExcept` (Repositories.ts:137/348/357) as the precedent pattern to mirror. Status → ready-for-agent.

**Plan validation (2026-09-29):** PARTIAL (confidence medium); workstream `two-factor-recovery-codes`. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:698`. Fix: Don't add prefix/count primitives to VerificationRepository. Implement bulk-replace and count on the `two_factor_recovery_code` repository when the two-factor plugin is built (ticket 05). Verification history purging comes from CSG-003's `deleteExpiredBefore`. (effort M). Full dossier: `.plan/slices/05-sql.md`.

**Resolved (2026-09-29):** Implemented on the two_factor_recovery_code repository (bulk replace in one transaction + unspent count), not on VerificationRepository, per the dossier. Tests: packages/two-factor/test/TwoFactorStore.test.ts (memory + SQLite), RecoveryCodes.test.ts.
