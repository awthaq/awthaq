---
ID: "TS-001"
Title: "Postgres row decode cannot succeed: BooleanFromBit and string-DateTime model variants contradict the pinned pg driver's binary codecs"
Level: high
Category: "correctness"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Models.ts:48"
Auditor: "tim-smart"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TS-001 — Postgres row decode cannot succeed: BooleanFromBit and string-DateTime model variants contradict the pinned pg driver's binary codecs

`HIGH` · `correctness` · `sql` · reported by **Effect Platform & Infrastructure Maintainer** (`tim-smart`)

Status: **resolved**

## Summary

The catalog pins effect@4.0.0-rc.116 and @effect/sql-pg@4.0.0-rc.116 (pnpm-workspace.yaml:17,20). In that pinned pair, @effect/sql-pg's binary protocol decodes PG bool (OID 16) to a JS boolean (PgTypes.ts:1167 `bytes[offset] !== 0`) and timestamptz to a `Date`, while effect rc.116's `BooleanFromBit` is documented to accept 'only 0 | 1' (Schema.ts:9897) and `Model.DateTimeInsert`'s select variant is `Schema.DateTimeUtcFromString` (Model.ts:506) — a string-only decode. SqlSchema performs no Date/boolean adaptation (no such code exists in SqlSchema.ts). Therefore every SELECT through makeRepository/SqlSchema on Postgres (`users.emailVerified` plus every createdAt/updatedAt/expiresAt column) hits a SchemaError before any test assertion can run, yet Repositories.postgres.test.ts:86 asserts `created.emailVerified === false` passes. Either that suite has never been green against rc.116 (it is skip-gated on AWTHAQ_POSTGRES_URL locally, and only CI sets it) or the environment drifted; ADR-EA-004's 'dialect-neutral by construction' claim does not hold for PG reads. Static review cannot execute the suite, but the three pinned facts together make a green run impossible as the code stands.

## Evidence

Source: `packages/sql/src/Models.ts:48`

```
emailVerified: Model.Field({
    select: Schema.BooleanFromBit,
    insert: Schema.BooleanFromBit.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
```

## Recommended fix

Choose one seam and align it: (a) use driver-shaped model variants (Model.DateTimeInsertFromDate etc.) plus a boolean select that accepts `true|false|0|1`, or (b) override the pg client's codecs (Registry/register) so bool/timestamptz decode to the shapes the models expect. Then run Repositories.postgres.test.ts against the pinned rc.116 pair in CI and keep it non-skippable there.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: platform & SQL integration
- Full dossier: [`tim-smart`](../../.reports/tim-smart/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-003` — verification_token rows carry no userId, so user deletion cannot clean up long-lived code rows](high/BCR-003-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`BCR-009` — Backup codes must be long-lived but expiresAt is NOT NULL and expiry fails as replay](low/BCR-009-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, low)_`
- [`CSG-006` — Core PII columns are plaintext at rest with no documented encryption boundary](medium/CSG-006-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, medium)_`
- [`ESS-010` — Documented latent decode asymmetry in VerificationToken.payload](low/ESS-010-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`ESS-011` — core/sql brand bridging is runtime-unchecked by design](info/ESS-011-effect-schema-specialist.md) `_(effect-schema-specialist, info)_`
- [`MA-008` — Identity brands are declared twice (core and sql); drift is silently bridged by string-typed re-wrap constructors](low/MA-008-michael-arnaldi.md) `_(michael-arnaldi, low)_`
- [`NAM-007` — Existing Auth.js sessions cannot be migrated — forced global re-authentication](medium/NAM-007-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- [`SCP-001` — No user deactivation state: SCIM active:false is unrepresentable, only hard delete exists](high/SCP-001-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, high)_`
- … 1 more findings touch `packages/sql/src/Models.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Postgres/SQLite dialect-neutral model strategy](../../.scratch/resolve-ready-for-human-findings/issues/29-dialect-neutral-model-strategy.md) — `Models.ts` becomes a `makeModels(dialect)` factory using Effect's own per-dialect `Model` field variants (`Model.BooleanSqlite`/plain-boolean, `DateTimeInsert`/`DateTimeInsertFromDate`, etc.) for the handful of dialect-sensitive columns, with `Repositories.ts` resolving `sql.dialect` once (mirroring `CoreMigrations.ts`'s existing `sql.onDialectOrElse` idiom) rather than globally overriding the pg client's codecs, which was rejected as an unacceptable side effect on a host app's own tables sharing the same ambient `SqlClient`. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — all three pinned facts check out against the installed rc.116 packages: `@effect/sql-pg`'s bool codec decodes OID 16 via `bytes[offset] !== 0` to a JS boolean (`PgTypes.ts` in the installed package), while `effect`'s `Schema.BooleanFromBit` is `Literals([0,1]).pipe(decodeTo(Boolean, ...))` — a literal-0-or-1-only decode that a real `boolean` input fails; `Model.DateTimeInsert.select` is `Schema.DateTimeUtcFromString` (exact match, installed `Model.ts:506`) while `timestamptz` decodes to a `Date`. `packages/sql/src/Models.ts:46-49` matches the evidence. Real correctness bug, but the fix requires choosing a dialect-neutral-model strategy (per-dialect model variants vs. overriding the pg client's codecs) — an architecture decision, not a mechanical patch. Status → ready-for-human.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `sql-dialect-neutral-models`. Evidence at HEAD ec065a7: `packages/sql/src/Models.ts:47`. Fix: Follow ticket 29's decision: `Models.ts` becomes a `makeModels(dialect)` factory that selects Effect's own per-dialect Model field variants for the dialect-sensitive columns (boolean and DateTime). `Repositories.ts` resolves `sql.dialect` once at layer construction. The pg client's codecs are never overridden globally. (effort L). Full dossier: `.plan/slices/05-sql.md`.

**Resolved (2026-09-29):** Models.ts is now a makeModels(dialect) factory (ticket 29 option adopted): pg -> Schema.Boolean/DateTimeUtcFromDate (+ Model.DateTimeInsertFromDate/UpdateFromDate), sqlite -> BooleanFromBit/DateTimeUtcFromString; JSON variants identical; per-dialect classes share one declaration of every dialect-independent field. Repositories resolve sql.dialect once per layer (Models.resolveDialect) and expose models; core builds insert/update inputs from repo.models. Models.dialectFields + mechanical row-schema moves in admin/jwt/organization/passkey/migrate-better-auth record stores (N10; each package gains an @awthaq/sql dependency). Tests: packages/sql/test/Models.test.ts (no-server pg/sqlite decode + encode + JSON identity; the pre-fix sqlite model rejects a pg row), and the real-Postgres 16 suite (pnpm run test:pg, docker postgres:16-alpine): 28/28 green incl. the shared contract cases. Deferred: plugin record stores' Postgres DDL/DML use unquoted mixed-case identifiers, so pg returns lower-cased column names and their row decode still cannot succeed end to end (separate defect, not a field-type problem); no pg-server test exists for them. Gates: typecheck (only the pre-existing packages/react TS2883 errors), full vitest 1017 passed, bdd, spec:verify:strict, oxlint.
