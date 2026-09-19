---
ID: "PPS-001"
Title: "Credential update is a non-transactional read-modify-write with a redundant internal re-read on the login hot path"
Level: high
Category: "performance"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:244"
Auditor: "postgres-performance-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PPS-001 — Credential update is a non-transactional read-modify-write with a redundant internal re-read on the login hot path

`HIGH` · `performance` · `sql` · reported by **Postgres Performance Specialist** (`postgres-performance-specialist`)

Status: **resolved**

## Summary

AccountsRepositoryLive.update internally re-reads the row (SELECT + 2 AES-GCM decrypts) just to recover providerId/userId for the encryption AAD, then issues the UPDATE, then decrypts the returned row again. Its caller — core's updateCredentialHash, the rehash-on-login path (packages/core/src/Accounts.ts:431-447) — has already done its own findById, so one rehash costs 3 round trips, 8 AES-GCM ops, and touches the session-login p99 twice for no reason. Worse, the sequence is not wrapped in a transaction, unlike the same file's unlink (packages/core/src/Accounts.ts:407 wraps withTransaction) and OAuth link (packages/oauth/src/OAuth.ts:682), so a concurrent unlink/delete can remove the row between the read and the write and the final UPDATE silently applies to nothing, or the re-read races the delete and dies. The doc comment at Repositories.ts:7-11 explicitly assigns the transaction boundary to the calling domain service, and that boundary is missing here.

## Evidence

Source: `packages/sql/src/Repositories.ts:244`

```
const existing = yield* repo
  .findById(input.id)
  .pipe(Effect.catchTag("NoSuchElementError", Effect.die));
```

## Recommended fix

Wrap updateCredentialHash in the SqlTransaction port and collapse the repository update to a single UPDATE accounts SET ... WHERE id = $1 RETURNING providerId, userId, ... so encryption AAD inputs come from RETURNING instead of a second findById; this makes the write atomic and cuts the login hot path from 3 round trips + 8 crypto ops to 1 round trip + 2 crypto ops.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 70/100), domain: Postgres performance
- Full dossier: [`postgres-performance-specialist`](../../.reports/postgres-performance-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `packages/sql/src/Repositories.ts:244-246` matches the evidence exactly (the internal `repo.findById` re-read inside `AccountsRepositoryLive.update`), and `packages/core/src/Accounts.ts`'s `updateCredentialHash` already does its own `findById` before calling `repo.update`, confirming the redundant double-read. `unlink` (`Accounts.ts:407`) and OAuth's create+link (`OAuth.ts:683`) both use `sql.withTransaction`; a grep for `SqlTransaction` in `Accounts.ts`/`Password.ts` shows `updateCredentialHash` uses neither. Fix (wrap in transaction, use `RETURNING` instead of a second read) is well-scoped. Status → ready-for-agent.

**Resolved (2026-09-20):** A literal `UPDATE ... RETURNING` rewrite turned out not to close the real gap: `providerId`/`userId` are excluded from `Account.update.Type` itself (`Models.ts`'s `FieldExcept(["update", "jsonUpdate"])`, correctly, since they're immutable identity columns), so they can never come from the update's own input, and they're needed *before* the write to encrypt the incoming `accessToken`/`refreshToken` with the right AAD — a `RETURNING` clause only yields values *after* the statement runs, too late to help construct that same statement's own `SET` values.

Took the recommended fix's other stated option instead, which the sibling `ESR-001` finding (same file, same defect) also names explicitly: `AccountsRepositoryShape.update` now takes a second parameter, `aad: {providerId, userId}`, supplied by the caller instead of re-derived via an internal `findById` — there is exactly one caller (`@awthaq/core`'s `updateCredentialHash`), confirmed via a repo-wide grep, and it already holds both values from its own prior read (the one BEH-EA-116's rehash-on-login flow needs anyway to pass `accessToken`/`refreshToken` through unchanged). This cuts the login hot path from 2 SELECTs + 1 UPDATE to 1 SELECT + 1 UPDATE, and removes 0 crypto ops directly (the encrypt/decrypt counts are unchanged — AAD still requires real work) but removes the entire redundant round trip and its own transaction-exposure window.

Separately, `updateCredentialHash` (`packages/core/src/Accounts.ts`) now wraps its read-then-write in `sql.withTransaction`, mirroring `unlink`'s own precedent exactly — closing the race the finding describes (a concurrent unlink/delete between the read and the write).

TDD: extended `packages/sql/test/Repositories.test.ts`'s existing `update` test to pass the new `aad` parameter, and added a new test using a real, non-null `accessToken`/`refreshToken` (the existing test used `null`, which can't distinguish a correct AAD from a wrong one, since encrypting/decrypting `null` is a no-op either way) — round-trips through `update` and a fresh `findById`, proving the caller-supplied `aad` genuinely re-encrypts correctly. Verified to genuinely fail: swapping the `providerId`/`userId` argument order inside `encryptToken`'s call sites reproduces a real AES-GCM authentication-tag failure (a die inside `Encryption.ts`, not a clean assertion failure) — proving the AAD is actually load-bearing, not decorative. Full monorepo `pnpm run typecheck` and `pnpm run test` both green (668 passed, 7 skipped).
