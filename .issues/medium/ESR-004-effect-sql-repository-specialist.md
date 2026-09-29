---
ID: "ESR-004"
Title: "Decrypt failures are collapsed to fiber defects, so one unreadable row poisons whole result-set operations"
Level: medium
Category: "api"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:199"
Auditor: "effect-sql-repository-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESR-004 — Decrypt failures are collapsed to fiber defects, so one unreadable row poisons whole result-set operations

`MEDIUM` · `api` · `sql` · reported by **Effect SQL Repository Specialist** (`effect-sql-repository-specialist`)

Status: **resolved**

## Summary

The `Encryption` port deliberately models `DecryptionFailed` and `UnknownKeyId` as typed errors (packages/ports/src/Encryption.ts:87, 102-105), but the repository immediately `orDie`s them. `AccountsRepositoryShape`'s error channel is only `SchemaError | SqlError`, so there is nowhere for a data-dependent failure to go. Consequence: a single row whose ciphertext fails authentication (bit rot, tampering, or a key evicted from `KeyProvider` after rotation) turns `listByUser`'s `Effect.forEach` and `findById` into fiber death for the whole operation — during key rotation, every account with an old-envelope token becomes unreadable rather than degraded.

## Evidence

Source: `packages/sql/src/Repositories.ts:199`

```
.decrypt(value, tokenAad(providerId, userId, field))
            .pipe(Effect.map(Redacted.value), Effect.orDie);
```

## Recommended fix

Add a typed decryption error to the repository error channel (or a `Redacted`-preserving raw-read escape hatch for admin/rotation tooling), and let list paths skip-and-log unreadable rows while point reads surface the failure.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 76/100), domain: SQL persistence layer
- Full dossier: [`effect-sql-repository-specialist`](../../.reports/effect-sql-repository-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-002` — No bulk-invalidate, list, or count primitives anywhere in the Verification stack](high/BCR-002-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`DRS-005` — Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding](medium/DRS-005-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ERAS-006` — SQL repositories are structurally driver-neutral, but no edge-viable SqlClient story exists or is documented](info/ERAS-006-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`EOTS-008` — Hand-written SQL queries bypass the spanPrefix spans that repository CRUD gets](medium/EOTS-008-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`ESR-001` — AccountsRepository.update is a non-transactional read-modify-write that can lose concurrently refreshed tokens](medium/ESR-001-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-003` — Email case-folding relies on lower() whose semantics diverge between SQLite and Postgres and from the app-level normalization](medium/ESR-003-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-005` — findByIdentifier cannot use the identifier index for consumed history and sorts unindexed](low/ESR-005-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- [`ESR-007` — verifyEmail hardcodes the bit literal 1 instead of the model's BooleanFromBit encoding](low/ESR-007-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- … 19 more findings touch `packages/sql/src/Repositories.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `sql-encrypted-token-read-path`. Duplicate of `SMS-002-secrets-management-specialist` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:225`. Full dossier: `.plan/slices/05-sql.md`. Status → resolved.
