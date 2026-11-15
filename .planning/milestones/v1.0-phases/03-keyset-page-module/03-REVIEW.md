---
phase: 03-keyset-page-module
reviewed: 2026-11-14T00:00:00Z
depth: deep
files_reviewed: 27
files_reviewed_list:
  - packages/ports/src/Keyset.ts
  - packages/ports/src/UserStore.ts
  - packages/ports/src/index.ts
  - packages/ports/test/Keyset.test.ts
  - packages/ports/test/Keyset.types.test.ts
  - packages/sql/src/KeysetSql.ts
  - packages/sql/src/UserStoreSql.ts
  - packages/sql/src/index.ts
  - packages/sql/test/KeysetSql.test.ts
  - packages/sql/test/CoreStoresSql.test.ts
  - packages/core/src/Users.ts
  - packages/admin/src/AdminApi.ts
  - packages/admin/src/AdminTenants.ts
  - packages/admin/src/ImpersonationRecords.ts
  - packages/admin/test/KeysetCursors.test.ts
  - packages/admin/test/KeysetHttp.test.ts
  - packages/admin/test/KeysetPins.test.ts
  - packages/admin/test/contract/ImpersonationRecords.ts
  - packages/organization/src/OrganizationDirectory.ts
  - packages/organization/src/OrganizationRecords.ts
  - packages/organization/test/contract/OrganizationRecords.ts
  - packages/test/src/internal/storeContract/users.ts
  - features/step-definitions/PersistenceMigrationSteps.ts
  - spec/behaviors/05-persistence-stratum.md
  - spec/overview.md
  - spec/traceability.md
  - .changeset/keyset-page-module.md
findings:
  critical: 0
  warning: 0
  info: 3
  total: 3
  necessity: 0
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-11-14
**Depth:** deep
**Files Reviewed:** 27
**Status:** issues_found (3 Info, no Critical, no Warning)

## Summary

The refactor is behaviour-preserving as claimed. Verified against the base commit `e74a8a9a` as oracle:

- **Limit/+1/trim/cursor** (`Keyset.ts:22-25, 107-124`): `limit()` is byte-for-byte the old clamp (trunc, 1..200, non-finite or undefined gives 50). `take = size + 1` is applied once, in `paginate`. The trim is `rows.slice(0, size)`; `nextCursor` comes from the last KEPT item, and only when `rows.length > size`. The extra row never reaches a caller. `limit + 1` survives only in `Keyset.ts` (the other grep hits are `RateLimiter` and a `SessionStoreSql` comment, out of scope).
- **Cursor wire bytes**: `AdminApi.CursorSchema`, `UserCursorSchema` and `AdminTenantsApi.OrganizationCursorSchema` are not in the diff. The cursor object is still `{ createdAt|startedAt, id }` in the same key order, built from the last kept row. The six golden literals in `KeysetCursors.test.ts` pass on memory and SQLite.
- **Order and predicate direction**: `Order.flip` for `desc` gives `against = order(cursor-row swapped)`, so `1` means "after the cursor" in each key's own direction. The `window` and `follows` first-non-tie logic matches the old comparators. Local oracles in `Keyset.test.ts` (copies of the old formulas) agree at every cursor and take, with ties on the first key and mixed-case ids. SQL: ascending uses `(c1,c2) > (?,?)` and ASC, descending uses `<` and DESC. `KeysetSql.test.ts` proves SQL equals `Keyset.window` on SQLite for asc, desc, 3 keys, and with tenant and `IS NULL` predicates.
- **Predicate composition**: the seek is one element of the `sql.and([...])` list. The tenant predicate stays first in the impersonation query, then `"endedAt" IS NULL`, then the seek. `sql.and([])` compiles to `1=1` (checked in `effect/sql/Statement.ts:808`). Org and users run `WHERE 1=1 ORDER BY ... LIMIT` on a first page.
- **SQL injection**: columns come only from the declaration and pass through `sql(identifier)`, which escapes. The direction is chosen from two fixed keywords. Cursor values are bound parameters. Tests cover a hostile column name and a hostile value.
- **Admin gate**: `Admin.ts:983-992` is untouched (empty diff). `gate.visibleEpisodes` still runs after `records.list`, and `nextCursor` is still taken from the pre-gate page. The short-page pin passes.
- **Wire limit**: `LimitSchema` uses `Keyset.MIN_LIMIT/MAX_LIMIT` (1 and 200), which is the same bounds and `isInt` as before. `KeysetHttp` pins 0, 201 and 2.5 to 400 and 200 to 200.
- **Stale copies**: `pageLimit`, `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `listLimit`, `byCreation`, `isBeforeCursor`, `newestFirst`(admin) and `toPage` are gone from core, admin, organization, ports and sql `src`. The webhooks constants remain by decision.
- **Untouched paths** (KEY-07): the `git diff --stat` over the Membership, SessionStore, AuditLog, RelayCursor, scim, webhooks and saml paths is empty.
- **Strata**: `Keyset.ts` imports only `effect`. `KeysetSql` imports `ports`. `pnpm circular` is clean. `AdminApi.ts` (plugin package, stratum above ports) importing ports is legal.
- **Gates re-run at HEAD**: `tsc -b`, `tsc -p tsconfig.test.json` (0 errors), `pnpm circular`, `check:error-tags`, `check:contract-tests`, `lint` (only pre-existing warnings), `format:check`, `spec/scripts/check-drift.mjs`, and 934 tests across the ten keyset, StoreContract (memory and sql), records-contract and CoreStoresSql files, all green.
- **Changeset Migration text**: every symbol it names exists in the shipped code (`UserStore.pageOrder`, `Keyset.window`, `Keyset.limit`, `DEFAULT_LIMIT`, `MAX_LIMIT`, the aliases) and every removed symbol is gone. No mismatch found beyond IN-03.

Not verifiable here: all Postgres legs (daemon down, `AWTHAQ_POSTGRES_URL` unset). The row-value form `("createdAt", id) > ($1, $2)` was already used by the old org query on Postgres, which lowers the risk for users and impersonations, but it is unproven locally.

No test found that cannot fail: each walk loop is bounded and asserts page counts, each oracle is written independently of the production declaration, and the exactly-full and clamp tables assert distinct outcomes.

## Info

### IN-01: The cursor-to-bound-values mapping is not owned by the declaration

**File:** `packages/sql/src/KeysetSql.ts:17,36-45`; call sites `packages/admin/src/ImpersonationRecords.ts:685`, `packages/organization/src/OrganizationRecords.ts:~441`, `packages/sql/src/UserStoreSql.ts:~203`
**Issue:** `Seek.after(sql, values: ReadonlyArray<unknown>)` takes the cursor values positionally, and each adapter hand-spells them (`[r.cursorStartedAt, r.cursorId]`). `Keyset.key` keeps the `cursor` accessor only inside the closed-over `against`, so the declaration cannot hand the values back. The arity guard catches a wrong count but not a swapped order: `seek.after(sql, [r.cursorId, r.cursorStartedAt])` compiles, passes the arity check, and on SQLite would compare dates to ids and silently return wrong pages. The current three call sites are correct and the contract tests would catch a swap, so this is a maintainability gap, not a live bug.
**Fix:** Optionally keep a `value: (cursor: Cursor) => unknown` per `Key` (or a `Declaration.valuesOf`) and let `KeysetSql` build the bound list from the cursor. The adapters would then pass the cursor itself, encoded through the request schema, instead of re-spelling the pair.

### IN-02: Tautological first assertion in `assertWire` call sites

**File:** `packages/admin/test/KeysetCursors.test.ts:189-200, 349-360`
**Issue:** These calls pass the same constant as both `produced` and `literal`, for example `assertWire(USERS_AFTER_SECOND_TIE, USERS_AFTER_SECOND_TIE, ...)`. The leading `assert.strictEqual(produced, literal)` can never fail there. The cursor bytes are really pinned by the earlier `deepStrictEqual(pages, ...)`, so the test is not vacuous, but the helper's first check adds no signal at those sites.
**Fix:** Drop `produced` at those sites, or pass the cursor actually read from `pages[n].cursor` instead of the constant.

### IN-03: Changeset Migration text is silent on the `UserStore` limit-normalisation shift

**File:** `.changeset/keyset-page-module.md:12`
**Issue:** For `OrganizationRecords` and `OrganizationDirectory` the text says they "normalise the limit themselves". For `UserStore.listPage` it only says the request shape and field name changed and that implementers should use `Keyset.paginate`. It does not say that `Users.list` no longer clamps before the store, so a third-party store now receives a raw, possibly `undefined`, `0` or `NaN` limit. The optional `limit?` type surfaces this at compile time, but a store that only renames `next` to `nextCursor` and keeps a manual `slice(0, limit)` would misbehave on `limit: 0`.
**Fix:** Add one clause: "`Users.list` no longer clamps; `UserStore.listPage` receives the caller's raw `limit`, which `Keyset.paginate` normalises."

---

_Reviewed: 2026-11-14_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
