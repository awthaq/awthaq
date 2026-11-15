---
phase: "03"
slug: "keyset-page-module"
status: audited
nyquist_compliant: true
wave_0_complete: true
created: "2026-11-14"
---

# Phase 03 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: `03-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 5.0.2 with `@effect/vitest`; Cucumber BDD (`pnpm test:bdd`) |
| **Config file** | root `vitest.config.ts` (`projects`); no new config |
| **Quick run command** | `npx tsc -b tsconfig.json && npx vitest run <touched files>` (cross-package tests need `tsc -b` first) |
| **Full suite command** | `pnpm test` plus the gate list below (CI runs Postgres inside `pnpm check`) |
| **Estimated runtime** | about 10 minutes for the full phase gate |

---

## Sampling Rate

- **After every task commit:** `npx tsc -b tsconfig.json` plus the touched package's vitest files
- **After every plan wave:** add `npx tsc -p tsconfig.test.json`, `pnpm circular`, `pnpm lint`, `pnpm format:check` (run `npx oxfmt` on new files first), `pnpm check:contract-tests`, targeted vitest of ports, sql, core, admin, organization and test
- **Before `/gsd-verify-work`:** the full gate list compared with the Wave 0 re-record in `03-BASELINE.md`
- **Max feedback latency:** 15 seconds per task for the quick loop

---

## Per-Task Verification Map

| Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|-----------|-------------------|-------------|--------|
| KEY-01 | clamp (1..200, default 50, non-finite, fractional), `take = limit + 1` once, next-cursor derivation, derived comparator | unit (fake `fetch`) | `npx vitest run packages/ports/test/Keyset.test.ts` | ❌ new file | ✅ green (Keyset.test.ts, Keyset.types.test.ts exist, pass) |
| KEY-02 | one page contract for users, organizations, impersonations; limit sweep over ties; exactly-full page; numeric 50 and 200 with 51 and 201 rows | contract and domain | `npx vitest run --project test`; admin, core and organization package tests | partial | ✅ green (`--project test` 34 files/662 pass; admin+organization+core 120 files/2086 pass) |
| KEY-03 | row-value fragment per listing (asc and desc), ORDER BY, composes with tenant and active predicates; mixed direction refused | unit (SQLite) | `npx vitest run packages/sql/test/KeysetSql.test.ts` | ❌ new file | ✅ green (KeysetSql.test.ts exists, pass) |
| KEY-04 | cursor bytes equal pinned literals for all 3 listings, memory and SQL | golden | the golden test file (committed in Wave 0 before any `src` change) | ❌ W0 | ✅ green (admin KeysetCursors.test.ts, 6 literals) |
| KEY-05 | ties by id, exactly-full final page, sub-ms timestamps, mixed-case ids (self-consistency), canonical-uuid parity | contract (memory, SQLite, WAL, libSQL, sealed; Postgres in CI) | `StoreContract` and `RecordsContract` suites; Postgres via CI `pnpm check` | extend existing | ⚠️ memory/SQLite/WAL/libSQL/sealed green; Postgres leg not run locally; CI confirmation open |
| KEY-06 | duplicates gone; post-page gate stays | grep and pin | `rg -n 'pageLimit\|listLimit\|MAX_PAGE_SIZE\|DEFAULT_PAGE_SIZE' packages/{core,admin,organization,ports,sql}/src` | n/a | ✅ green (rg prints nothing, exit 1; baseline was 16 lines) |
| KEY-07 | Membership offset paging, `SessionStore.listLive`, SCIM paging, audit log, webhook deliveries untouched | diff | `git diff --stat <phase-base>..HEAD -- <KEY-07 paths>` is empty | n/a | ✅ green (git diff --stat e74a8a9a HEAD over BASELINE path list is empty) |
| KEY-08 | `surface:ports` lists the module; BEH-EA-036 amended; collation declared | spec drift | `pnpm spec:verify:strict` | ✅ | ✅ green (verify-traceability --strict PASS 32 FAIL 0 SKIP 0) |
| GATE-04 | Postgres verified in CI; local run recorded as "not run locally" | CI and record | CI run of `pnpm check` with `AWTHAQ_POSTGRES_URL` | CI only | ⏳ open: not run locally; CI confirmation open |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] Gate baseline re-recorded at HEAD in `03-BASELINE.md` (template: `02-BASELINE.md`), including `check:contract-tests`, `package:smoke` and "test:pg not run locally"
- [x] Golden cursor test pinned to today's code, committed before any `src` change (KEY-04)
- [x] Pin matrix against today's domain-level behaviour (`Users.list`, `AdminTenants.listOrganizations`, `Admin.list`, HTTP): numeric default 50 and max 200, tie order, exactly-full page, clamp list `[0,-3,2.5,NaN,10000]`, tenant and active filter, post-page gate short page with non-None cursor, organization HTTP wire cursor
- [x] KEY-06 grep baseline and the KEY-07 path list recorded
- [x] No framework install needed

---

## Manual-Only Verifications

All locally verifiable behaviors have automated verification. Postgres-gated (KEY-05 Postgres leg, GATE-04): not run locally; CI confirmation open. Postgres-gated cases cannot run locally (`AWTHAQ_POSTGRES_URL` unset; the docker CLI is installed but the daemon is down); record "not run locally" and rely on the CI run.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** nyquist-compliant for every locally verifiable behavior (2026-11-14). Open, not green: GATE-04 and the KEY-05 Postgres leg, not run locally; CI confirmation open.
