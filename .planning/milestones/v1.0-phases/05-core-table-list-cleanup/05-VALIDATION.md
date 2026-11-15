---
phase: "05"
slug: "core-table-list-cleanup"
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-11-14"
---

# Phase 05 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: `05-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest with `@effect/vitest`; Cucumber BDD (`pnpm test:bdd`) |
| **Config file** | root `vitest.config.ts` (`projects`); no new config |
| **Quick run command** | `npx tsc -b tsconfig.json && npx vitest run packages/sql/test/CoreTablePins.test.ts packages/sql/test/CoreTables.test.ts packages/sql/test/TenantScoped.test.ts packages/test/test/LaggingReplica.test.ts packages/core/test/AuthTenancy.test.ts` |
| **Postgres run** | `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq npx vitest run packages/sql/test/CoreTablePins.test.ts packages/sql/test/CoreTables.test.ts packages/sql/test/TenantScope.postgres.test.ts packages/sql/test/CoreMigrations.postgres.test.ts packages/sql/test/ReadRouting.postgres.test.ts packages/sql/test/TenantScoped.test.ts` (Debian `postgres:16` container, same image CI uses) |
| **Full suite command** | `pnpm test`, `pnpm test:bdd`, then the gate list in `05-BASELINE.md` |
| **Estimated runtime** | about 10 minutes for the full phase gate |

---

## Sampling Rate

- **After every task commit:** `npx tsc -b tsconfig.json` plus the quick run
- **After every plan wave:** `pnpm test`, `pnpm test:bdd`, the Postgres run
- **Before `/gsd-verify-work`:** every gate in `05-BASELINE.md` at or equal to the Wave 0 baseline
- **Max feedback latency:** 15 seconds per task for the quick loop

---

## Per-Task Verification Map

| Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|-----------|-------------------|-------------|--------|
| CAT-01 | catalogue is the single list; `partitionedTables`, `directoryTables`, `coverage`, `LaggingReplica.coreTables`, stamped view equal the literals they replace; `Auth.make` accepts exactly the stamped tables as Derived parents; BDD stamping outlines pass | unit + BDD | quick run (5 files, 41/41); `pnpm test:bdd` (39 files, 1580 passed, 44 skipped) | pins W0, `CoreTables.test.ts` W1, `AuthTenancy.test.ts` extended | ✅ green: CoreTablePins, CoreTables, LaggingReplica, AuthTenancy, 28-tenancy BDD |
| CAT-01 | no remaining hand-kept list | census | `grep -rnE '"verification_reservations"' packages/*/src features/step-definitions \| wc -l` | command | ✅ green: 2 lines (`CoreTables.ts`, `TenancySteps.ts` case label) |
| CAT-02 | `auth_relay_cursor` and `rate_limit_buckets` classified `tenancy: "none"`, `replicated: false`, non-empty reason; drift guard covers `rate_limit_buckets` via its own migrator | unit (SQLite + Postgres) | `npx vitest run packages/sql/test/CoreTables.test.ts` and the Postgres run | W1 | ✅ green: CoreTables.test.ts on SQLite (quick run) and Postgres (44/44) |
| CAT-03 | catalogue keys only `name, owner, tenancy, replicated, sealed, reason`; sealed AAD list, `key`, `adoptPlaintext` frozen; `sealed` equals `deployed({encryptPii:true})`; no new dependency or cycle | unit + static | `CoreTablePins.test.ts` + `CoreTables.test.ts`; `pnpm circular`; package.json/lockfile diff over the phase | W0 / W1 | ✅ green: both files pass; `pnpm circular` no findings; no package.json or lockfile diff since `ea56a16f` |
| CAT-04 | minimal-fix branch not taken, reasoning recorded; closing census | doc + census | `05-BASELINE.md` "CAT-04 closure" and census table (7/7 MET) | exists | ✅ green: census 4 lines to 2; hand-list counts to 0; barrel export 0 to 1 |
| GATE-04 | drift guard, RLS table set, RLS and ReadRouting suites on Postgres | integration (Postgres) | the Postgres run | W0 / W1 | ✅ green: Postgres run 6 files, 44/44 (local CI image, Debian postgres:16; CI confirmation open, no git remote) |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `05-BASELINE.md` recorded at the planning HEAD (every gate, Postgres container version)
- [x] `packages/sql/test/CoreTablePins.test.ts` (literal lists, `coverage` matrix, AAD tuples, created-table set), add commit `7720a413`, unmodified since
- [x] `packages/test/test/LaggingReplica.test.ts` oracle, add commit `31385d7b`, unmodified since
- [x] `TenantScope.postgres.test.ts` RLS table-set pin and `AuthTenancy.test.ts` additions are additions only (0 removed lines)

---

## Manual-Only Verifications

None. The Postgres legs run on the local Debian `postgres:16` container; hosted CI cannot run (no git remote), so the record says "run locally on the CI image, CI confirmation open".

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-11-14

## Validation Audit 2026-11-14

| Metric | Count |
|---|---|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |
