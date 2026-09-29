---
ID: "TS-005"
Title: "Account token decryption failures are collapsed with Effect.orDie instead of the port's typed error channel"
Level: low
Category: "correctness"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:199"
Auditor: "tim-smart"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TS-005 — Account token decryption failures are collapsed with Effect.orDie instead of the port's typed error channel

`LOW` · `correctness` · `sql` · reported by **Effect Platform & Infrastructure Maintainer** (`tim-smart`)

Status: **resolved**

## Summary

`Encryption.decrypt` deliberately declares `DecryptionFailed | UnknownKeyId` (Encryption.ts:105) — the UnknownKeyId case is the designed rotation story (KeyProvider.ts:20-23). Collapsing it with orDie means a row written under a retired kid, or a ciphertext/key mismatch after a restore, kills the request fiber as a defect instead of surfacing a typed, per-row recoverable error; listByUser fails wholesale because one row is undecryptable, with no diagnostic path short of a defect log.

## Evidence

Source: `packages/sql/src/Repositories.ts:199`

```
: encryption
            .decrypt(value, tokenAad(providerId, userId, field))
            .pipe(Effect.map(Redacted.value), Effect.orDie);
```

## Recommended fix

Let decryption errors flow into RepositoryError (or a dedicated `TokenUndecryptable` case) so callers can distinguish 'skip/log this row' from 'the database is broken', and document the rotation contract (multi-key KeyProvider) that prevents UnknownKeyId in normal operation.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: platform & SQL integration
- Full dossier: [`tim-smart`](../../.reports/tim-smart/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

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

**Resolved (2026-09-29):** Duplicate of `SMS-002-secrets-management-specialist` — closed by its fix (see that issue's Resolved comment).
