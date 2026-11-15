---
phase: 03-keyset-page-module
fixed_at: 2026-11-14T00:00:00Z
review_path: .planning/phases/03-keyset-page-module/03-REVIEW.md
iteration: 1
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 3: Code Review Fix Report

**Fixed at:** 2026-11-14
**Source review:** .planning/phases/03-keyset-page-module/03-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 3 (3 Info; no Critical or Warning; fix scope widened to Info by the caller)
- Fixed: 3
- Skipped: 0

Edited in the main checkout (`workflow.use_worktrees` is `false`); verification ran there.

## Fixed Issues

### IN-01: The cursor-to-bound-values mapping is not owned by the declaration

**Files modified:** `packages/sql/src/KeysetSql.ts`, `packages/sql/src/UserStoreSql.ts`, `packages/admin/src/ImpersonationRecords.ts`, `packages/organization/src/OrganizationRecords.ts`, `packages/sql/test/KeysetSql.test.ts`, `spec/traceability.md`
**Commit:** 82f83c7e (requires human verification: logic change, Postgres legs not run locally)
**Applied fix:** `Seek.after(sql, values: ReadonlyArray<unknown>)` is now `Seek.after(sql, cursor)`. The seek binds `cursor[k.column]` for each declared key, in key order, so no caller spells values positionally and a swapped pair cannot be written. The reviewer's suggestion (a `value` accessor on `Key`) was adapted: the adapters bind the dialect-encoded wire values (`wire.dateTime` is `DateTimeUtcFromString` on SQLite and `DateTimeUtcFromDate` on Postgres), and a typed `DateTime.Utc` read through a port-level accessor cannot be bound raw, nor can ports import the dialect codec. Instead each adapter's request schema is now `{ cursor: NullOr(Struct({ <column>: wire.dateTime, id: String })), take }` and the adapter passes `Option.getOrNull(after)` whole; the schema encodes it and the seek reads the columns from the encoded cursor. The arity guard became a missing-column guard (`InvariantViolation`, invariant `keyset cursor columns`), still meaningful as a misspelt field name is refused at the first seek. `column`/`direction` semantics, the mixed-direction refusal, parameter binding and the emitted SQL are unchanged (the compiled-SQL test pins text and parameter order; it now passes the cursor fields in reverse order to prove key order wins). No `as`/`any`; ports untouched. `spec/traceability.md` row for `KeysetSql.test.ts` said "arity refusal": updated, Revision 1.91 to 1.92 with a Change History entry.

### IN-02: Tautological first assertion in `assertWire` call sites

**Files modified:** `packages/admin/test/KeysetCursors.test.ts`
**Commit:** a81ae5f6
**Applied fix:** the four call sites (users limit-2 walk, impersonation limit-3 walk, two each) now pass the cursor read from `pages[n].cursor` (new `cursorAfter` helper, fails if the page answered none) as `produced`, and the pinned constant as `literal`. No pinned literal changed.

### IN-03: Changeset Migration text is silent on the `UserStore` limit-normalisation shift

**Files modified:** `.changeset/keyset-page-module.md`
**Commit:** 7e28ebac (with this report)
**Applied fix:** the Migration paragraph now says `Users.list` no longer clamps, `UserStore.listPage` receives the caller's raw `limit` (possibly `undefined`, `0` or `NaN`), a third-party store must clamp via `Keyset.paginate` or `Keyset.limit`, and a store that keeps its own `slice(0, limit)` misbehaves on limit 0. Confirmed against `packages/core/src/Users.ts:800`.

## Gate results (run in the main checkout)

| Gate | Result |
|---|---|
| `npx tsc -b tsconfig.json`, `npx tsc -p tsconfig.test.json` | no `error TS` after each fix |
| `npx oxfmt` on edited `.ts` files | clean |
| vitest: KeysetSql, ports Keyset, `packages/admin/test`, `packages/organization/test`, CoreStoresSql | 55 files, 1283 passed, 1 skipped |
| `npx vitest run --project test` (StoreContract suites) | 34 files, 662 passed, 1 expected fail |
| Wave 0 oracles (KeysetCursors, KeysetPins, KeysetHttp) | 36 passed after IN-02, unedited literals |
| `pnpm circular` | exit 0 |
| `pnpm lint` | exit 0, no finding under `packages/` |
| `pnpm format:check` | all matched files use the correct format |
| `pnpm test:bdd` | 39 files, 1576 passed, 44 skipped |
| `bash spec/scripts/verify-traceability.sh --strict` | PASS 32, FAIL 0, SKIP 0 |
| `node spec/scripts/check-drift.mjs` | no FAIL |
| knip (filtered to packages/examples/features/scripts/spec) | only the 3 `readme-quickstart.ts` rows |

Not run: Postgres legs (daemon down, `AWTHAQ_POSTGRES_URL` unset). The SQL text and parameter order are identical to before; the Postgres bind form of the cursor values is the same `wire.dateTime` codec the nullable variant used (`NullOr(codec)` encodes a non-null value through `codec`).

---

_Fixed: 2026-11-14_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
