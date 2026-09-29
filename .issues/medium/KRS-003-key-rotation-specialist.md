---
ID: "KRS-003"
Title: "Reads of old-key ciphertext rows die as defects instead of a typed error"
Level: medium
Category: "correctness"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:199"
Auditor: "key-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# KRS-003 — Reads of old-key ciphertext rows die as defects instead of a typed error

`MEDIUM` · `correctness` · `sql` · reported by **Key Rotation Specialist** (`key-rotation-specialist`)

Status: **resolved**

## Summary

AccountsRepository.decryptToken converts both DecryptionFailed and UnknownKeyId into defects via Effect.orDie. Exactly the conditions a key rotation produces — a row written under a kid the provider no longer knows, or a failed authentication check — therefore crash the whole repository call as a defect instead of surfacing a catchable, per-row failure. The post-rotation answer for old-key rows is 'every read of an affected account 500s as a defect', with no way for callers (e.g. token refresh flows) to treat it as a recoverable condition or trigger re-encryption.

## Evidence

Source: `packages/sql/src/Repositories.ts:199`

```
.decrypt(value, tokenAad(providerId, userId, field))
  .pipe(Effect.map(Redacted.value), Effect.orDie);
```

## Recommended fix

Let decrypt failures propagate as typed errors on the repository's error channel (or map them to a null-token result plus an auth-event), and add a lazy re-encrypt-on-read that rewrites old-kid envelopes under currentKey.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: Key lifecycle & rotation
- Full dossier: [`key-rotation-specialist`](../../.reports/key-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-002` — No bulk-invalidate, list, or count primitives anywhere in the Verification stack](high/BCR-002-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`DRS-005` — Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding](medium/DRS-005-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ERAS-006` — SQL repositories are structurally driver-neutral, but no edge-viable SqlClient story exists or is documented](info/ERAS-006-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`EOTS-008` — Hand-written SQL queries bypass the spanPrefix spans that repository CRUD gets](medium/EOTS-008-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`ESR-001` — AccountsRepository.update is a non-transactional read-modify-write that can lose concurrently refreshed tokens](medium/ESR-001-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-003` — Email case-folding relies on lower() whose semantics diverge between SQLite and Postgres and from the app-level normalization](medium/ESR-003-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-004` — Decrypt failures are collapsed to fiber defects, so one unreadable row poisons whole result-set operations](medium/ESR-004-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-005` — findByIdentifier cannot use the identifier index for consumed history and sorts unindexed](low/ESR-005-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- … 19 more findings touch `packages/sql/src/Repositories.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `sql-encrypted-token-read-path`. Duplicate of `SMS-002-secrets-management-specialist` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:225`. Full dossier: `.plan/slices/05-sql.md`. Status → resolved.
