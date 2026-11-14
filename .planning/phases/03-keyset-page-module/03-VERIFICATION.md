---
phase: 03-keyset-page-module
verified: 2026-11-14T09:00:00Z
status: passed
score: 5/5 roadmap truths verified; Postgres legs confirmed locally on Debian postgres:16 (en_US.utf8), the image CI uses
covered_files:
  - .planning/phases/03-keyset-page-module/03-01-PLAN.md
  - .planning/phases/03-keyset-page-module/03-01-SUMMARY.md
  - .planning/phases/03-keyset-page-module/03-02-PLAN.md
  - .planning/phases/03-keyset-page-module/03-02-SUMMARY.md
  - .planning/phases/03-keyset-page-module/03-03-PLAN.md
  - .planning/phases/03-keyset-page-module/03-03-SUMMARY.md
  - .planning/phases/03-keyset-page-module/03-04-PLAN.md
  - .planning/phases/03-keyset-page-module/03-04-SUMMARY.md
  - .planning/phases/03-keyset-page-module/03-05-PLAN.md
  - .planning/phases/03-keyset-page-module/03-05-SUMMARY.md
  - .planning/phases/03-keyset-page-module/03-06-PLAN.md
  - .planning/phases/03-keyset-page-module/03-06-SUMMARY.md
  - .planning/phases/03-keyset-page-module/03-07-PLAN.md
  - .planning/phases/03-keyset-page-module/03-07-SUMMARY.md
  - .planning/phases/03-keyset-page-module/03-08-PLAN.md
  - .planning/phases/03-keyset-page-module/03-08-SUMMARY.md
  - .planning/phases/03-keyset-page-module/03-09-PLAN.md
  - .planning/phases/03-keyset-page-module/03-09-SUMMARY.md
  - packages/admin/src/ImpersonationRecords.ts
  - packages/admin/test/KeysetCursors.test.ts
  - packages/organization/src/OrganizationRecords.ts
  - packages/ports/src/Keyset.ts
  - packages/ports/src/UserStore.ts
  - packages/sql/src/KeysetSql.ts
covered_digest: "v4:sha256:ddaf390dd82fe9183c6caa140c82f1fa1746f6829ec39db8de99b8c74328010a"
behavior_unverified: 0
overrides_applied: 0
human_verification: []
---

# Phase 3: Keyset-page module Verification Report

**Phase Goal:** Users, organizations and impersonations page through one keyset module with one page contract, byte-identical cursors, and Postgres-verified ordering.
**Verified:** 2026-11-14
**Status:** passed (all code, local gates and spec checks pass; the Postgres legs were confirmed afterwards, see "Postgres confirmation" below)
**Re-verification:** No, initial verification (verified against HEAD, which includes review fixes 82f83c7e, a81ae5f6, 7e28ebac)

## Goal Achievement

### Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Keyset module in `@awthaq/ports` owns clamp 1..200/default 50, `limit + 1`, next cursor and in-memory comparator; users, organizations, impersonations list through it; `OrganizationRecords.listPage` and `AdminTenants` changed together; post-page gate stays in caller | VERIFIED | `packages/ports/src/Keyset.ts`: `limit()` (non-finite -> 50, `Math.trunc`, clamp), `paginate` (`take: size + 1`, trim, `nextCursor` only when `rows.length > size`), `window` (sort by declared keys, strictly-after filter, slice). `rg 'limit \+ 1\|\+ 1'` over core/admin/organization/ports/sql src: the only non-comment `limit`-add is `Keyset.ts:113` (`size + 1`); the other hit is a comment in `SessionStoreSql.ts` (listLive, out of scope). All three listings call `Keyset.paginate` + `Keyset.window`/`KeysetSql.make` (UserStore.ts:377, UserStoreSql.ts:485, OrganizationRecords.ts:245/445, ImpersonationRecords.ts:440/750). `AdminTenants.listOrganizations` now passes `input?.limit` straight to `directory.listPage` and returns its page; `OrganizationDirectory.listPage` returns `Keyset.Page`. `Admin.ts` empty diff vs e74a8a9a; `gate.visibleEpisodes` still at Admin.ts:990. |
| 2 | Golden test pins cursors byte-identical per listing against today's three schemas | VERIFIED | `packages/admin/test/KeysetCursors.test.ts` passes (12 tests, memory and SQL). Between add commit 667e9918 and HEAD: +98/-4; the 4 removed lines are the first argument of four `assertWire(...)` call sites (changed from the pinned constant to the cursor a walk produced, IN-02); no cursor literal or schema pin removed or edited, later lines appended. Cursor schemas (`CursorSchema` etc.) are not in the diff (`AdminApi.ts` diff = `LimitSchema` bounds only). |
| 3 | SQL row-value predicate builder replaces expanded-OR spellings and rejects mixed-direction orders, shown by a test | VERIFIED | `packages/sql/src/KeysetSql.ts`: `make` throws `Defects.InvalidConfiguration` for mixed directions; `after` emits `(c1,c2) > (?,?)` / `<` with bound params from `cursor[column]`; `orderBy` derived. Test `KeysetSql.test.ts:180` "make refuses a mixed-direction declaration with a tagged defect" passes. No `"createdAt" >`/`startedAt <` expanded spellings remain in UserStoreSql/ImpersonationRecords/OrganizationRecords (original UserStoreSql had `WHERE "createdAt" > ...` at e74a8a9a:189). |
| 4 | StoreContract/RecordsContract page-order cases pass on memory and Postgres, `pnpm test:pg` passes in CI, phase records "not run locally" | PARTIAL: code-complete; Postgres/CI OPEN | Cases exist: users contract (`packages/test/src/internal/storeContract/users.ts`: ties by id at limits 1..8 :555, exactly-full final page :598, mixed-case self-consistency :630, canonical uuidV7 exact parity :646, sub-ms/whole-ms), organization contract (:314 exactly-full, :350 ties across all page sizes), impersonation contract (:528). They pass on memory and SQLite (full `pnpm test` 417 files / 6593 tests passed). Postgres legs skipped locally (docker down, `AWTHAQ_POSTGRES_URL` unset). `03-09-SUMMARY.md` "Open CI confirmations (not run locally)" lists six open items, none counted as passes. Routed to human verification. |
| 5 | Grep finds no `pageLimit`/`listLimit`/stale `MAX_PAGE_SIZE`; KEY-07 paths untouched; `surface:ports` lists module; BEH-EA-036 amended; collation declared | VERIFIED | Scoped rg over `packages/{core,admin,organization,ports,sql}/src` returns empty. Only survivor workspace-wide: `packages/webhooks/src/WebhooksApi.ts:138` `MAX_PAGE_SIZE = 200` (deliveries, intentionally out of scope). `git diff --stat e74a8a9a HEAD` over the 13 KEY-07 paths (MembershipRecords, Organization, OrganizationHandlers, OrganizationApi, SessionStore, AccountStore, AuditLogStore, SessionStoreSql, AuditLogStoreSql, RelayCursorStoreSql, scim, webhooks, saml): empty. `spec/overview.md` line 47 and line 141 list `Keyset` (Rev 1.18). BEH-EA-036 in `spec/behaviors/05-persistence-stratum.md`: "No core store port's public interface MAY accept an offset", Revision 1.13 -> 1.14 and Change History 1.14 entry added together; "Collation and precision" paragraph declares canonical uuidV7 id order collation-stable and names `COLLATE "C"` as fallback. `bash spec/scripts/verify-traceability.sh --strict`: PASS 32, FAIL 0, SKIP 0. |

**Score:** 5/5 truths verified in code and locally runnable gates; truth 4's Postgres/CI leg is open (human_needed). 0 behavior-unverified.

### Requirements Coverage

| Requirement | Verdict | Evidence |
|-------------|---------|----------|
| KEY-01 | SATISFIED | `Keyset.ts` owns clamp, the single `+1`, next cursor, `window` comparator derived from declared keys; barrel `packages/ports/src/index.ts:37`; overview `surface:ports` lists it. |
| KEY-02 | SATISFIED | users (`UserStore.pageOrder`, `Users.list` passes raw limit, `nextCursor` renamed from `next`), organizations (`OrganizationRecords.listPage` -> `Keyset.Page`, `OrganizationDirectory.listPage`, `AdminTenants.listOrganizations` consistent, limit applied once), impersonations (`ImpersonationRecords.list`) all through `Keyset.paginate`; `Admin.ts` unchanged, post-page `visibleEpisodes` gate in the caller. `KeysetPins.test.ts` (18) and `KeysetHttp.test.ts` (4) pass. |
| KEY-03 | SATISFIED | `KeysetSql.ts` row-value seek + ORDER BY; mixed-direction refusal tested; no expanded-OR remains. SQLite verified; Postgres placeholder/`timestamptz` binding open under KEY-05. |
| KEY-04 | SATISFIED | Golden test passes; pinned literals unchanged since 667e9918 (only first args of 4 `assertWire` calls changed per IN-02, a strengthening); cursor schemas not in diff. `KeysetPins`/`KeysetHttp` are single-commit +0 deletions. |
| KEY-05 | CODE-COMPLETE; CI OPEN (human_needed) | Cases present and passing on memory and SQLite. Postgres legs and `pnpm test:pg` in CI not run (docker down, `AWTHAQ_POSTGRES_URL` unset). Not claimed as a pass. |
| KEY-06 | SATISFIED | Scoped grep empty; webhooks `MAX_PAGE_SIZE` survivor intentional (deliveries, KEY-07). Post-page gate in caller. |
| KEY-07 | SATISFIED | Empty diff over all 13 listed paths. |
| KEY-08 | SATISFIED | overview Rev 1.18 lists `Keyset`; BEH-EA-036 amended with Revision 1.14 and Change History bumped together; collation declared; traceability strict PASS 32/0/0; `.changeset/keyset-page-module.md` has `Migration:` line and matches shipped API (`next` -> `nextCursor`, `byCreation` removed in ports (no remaining `UserStore.byCreation`; saml/scim `byCreation` are unrelated local helpers), `pageLimit`/`DEFAULT_PAGE_SIZE`/`AdminApi.MAX_PAGE_SIZE` removed per grep, `Users.list` no longer clamps per IN-03). The "mixed-case `test:pg` case" half is code-present, CI-open under KEY-05. |
| GATE-04 | CODE-COMPLETE; CI OPEN (human_needed) | "Record not run locally" is satisfied by 03-BASELINE.md and 03-09-SUMMARY.md "Open CI confirmations"; the Postgres/CI verification itself is outstanding. |

No orphaned requirements: REQUIREMENTS.md maps exactly KEY-01..KEY-08 and GATE-04 to Phase 3.

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| `UserStore.pageOrder` | `UserStoreSql` seek and memory window | `KeysetSql.make(UserStore.pageOrder)` (UserStoreSql.ts:58), `Keyset.window(pageOrder, ...)` (UserStore.ts:378) | WIRED |
| `OrganizationRecords.pageOrder` | sql + memory | `KeysetSql.make(pageOrder)` (:301), `Keyset.window` (:246) | WIRED |
| `ImpersonationRecords.pageOrder` | sql + memory | `KeysetSql.make(pageOrder)` (:204), `Keyset.window` (:452) | WIRED |
| `AdminTenants.listOrganizations` | `OrganizationDirectory.listPage` -> `OrganizationRecords.listPage` | limit passed through once, page returned unchanged | WIRED |
| `Users.list` | `UserStore.listPage` | raw limit; `nextCursor` mapped through | WIRED |
| `AdminApi.LimitSchema` | `Keyset.MIN_LIMIT/MAX_LIMIT` | `Schema.isBetween` | WIRED |
| `Keyset`, `KeysetSql` | package barrels | `ports/src/index.ts:37`, `sql/src/index.ts:31` | WIRED |

### Data-Flow Trace (Level 4)

Cursor and rows flow from real queries (SQL: `SELECT ... WHERE (cols) > (?,?) ORDER BY ... LIMIT take`; memory: sorted state map). `KeysetHttp.test.ts` and `KeysetCursors.test.ts` assert real wire bytes end to end. No static/hollow data found.

### Behavioral Spot-Checks and Gates (run in this verification)

| Check | Command | Result |
|-------|---------|--------|
| Build | `npx tsc -b tsconfig.json` | exit 0 |
| Test typecheck | `npx tsc -p tsconfig.test.json` | 0 `error TS` |
| Cycles | `pnpm circular` | no findings |
| Keyset tests | `npx vitest run packages/ports/test/Keyset*.test.ts packages/sql/test/KeysetSql.test.ts packages/admin/test/Keyset*.test.ts` | 6 files, 58 tests passed |
| test project | `npx vitest run --project test` | 34 files, 662 passed, 1 expected fail |
| Full unit | `pnpm test` | 417 files passed / 4 skipped; 6593 passed, 1 expected fail, 15 skipped (matches 03-09 record) |
| BDD | `pnpm test:bdd` | 39 files; 1576 passed, 44 skipped |
| Traceability | `bash spec/scripts/verify-traceability.sh --strict` | PASS 32, FAIL 0, SKIP 0 |
| Flaky passkey ChallengeStore case | n/a | did not fail in this run |

### Anti-Patterns Found

None blocking. No TBD/FIXME/XXX introduced in the keyset files. `KeysetSql.after` throws `InvariantViolation` on a missing cursor column (defensive, tested).

### Allowlist

`git diff --name-only e74a8a9a HEAD` (non-planning): `.changeset/keyset-page-module.md`; `features/step-definitions/PersistenceMigrationSteps.ts`; `packages/{ports,sql,core,admin,organization}/{src,test}` files named by the phase; `packages/test/src/internal/storeContract/users.ts`; `spec/behaviors/05-persistence-stratum.md`, `spec/overview.md`, `spec/traceability.md`. Nothing outside the allowlist; no knip.json/package.json/lockfile change.

### Review Dispositions

`03-REVIEW-DISPOSITION.md`: IN-01, IN-02, IN-03 all `fixed` (82f83c7e, a81ae5f6, 7e28ebac), open 0. `03-SECURITY.md`: `status: verified`, `threats_open: 0`. Final code verified at HEAD.

### Human Verification Required

1. **Postgres CI run (KEY-05, GATE-04, KEY-03 Postgres leg).** Run CI `pnpm check` on the phase head with `AWTHAQ_POSTGRES_URL` set (postgres:16 service), or `pnpm test:pg`. Expected: green, including the users StoreContract KEY-05 cases, admin/organization RecordsContract sql mode, `KeysetSql.test.ts` on Postgres and the golden's SQL legs. Why human: docker daemon down and env var unset locally; Postgres legs are skipped, not passed.
2. **Collation drift.** The canonical uuidV7 parity case on CI's glibc `en_US.utf8` Postgres. Expected pass; on failure the documented fallback is `COLLATE "C"` as a follow-up (never a test edit). Why human: only CI reproduces it.

### Gaps Summary

No code or spec gaps. Every local, runnable verification passes against the HEAD code. The sole outstanding item is the Postgres/CI confirmation, which the phase itself records as "not run locally" and lists as six open CI confirmations in `03-09-SUMMARY.md`. KEY-05 and GATE-04 should be treated as code-complete with CI confirmation open; do not claim a Postgres pass.

---

## Postgres confirmation (orchestrator, after the verifier's human_needed)

The verifier could not run Postgres (Docker daemon down; the repo has no git remote, so no hosted CI either). With the user's approval the orchestrator launched Docker Desktop and ran a throwaway `postgres:16` container (Debian, PostgreSQL 16.16, `datcollate` = `datctype` = `en_US.utf8`): the same image and collation CI's service container uses. Local `pnpm test:pg` uses alpine, which hides collation drift.

With `AWTHAQ_POSTGRES_URL` pointing at it, at phase head `db288f17` (post-review fixes):

| Run | Result |
|-----|--------|
| keyset-related suites (`packages/sql`, `admin`, `organization`, `ports` tests and `core/test/Users.test.ts`) | 102 files, 1736 tests passed |
| `--project test` (StoreContract incl. `UserStore (SQL)` and sealed: ties at limits 1..8, normalised limits, exactly-full page, sub-ms instants, mixed-case self-consistency, canonical uuidV7 exact code-unit order) | 34 files, 662 passed, 1 expected fail |
| `pnpm test` (all projects) | 421 files, 6629 passed, 1 expected fail, exit 0 |
| `pnpm test:bdd` | 39 files, 1576 passed, 44 skipped, exit 0 |

The collation fallback (`COLLATE "C"`) was not needed: the canonical-id parity case passes on glibc `en_US.utf8`. KEY-05 and GATE-04 are satisfied on real Postgres evidence. A hosted CI run was not possible (no git remote); this is the CI-equivalent run.

_Verified: 2026-11-14_
_Verifier: Claude (gsd-verifier)_
