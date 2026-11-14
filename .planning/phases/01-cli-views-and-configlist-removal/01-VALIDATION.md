---
phase: "01"
slug: "cli-views-and-configlist-removal"
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-11-14"
---

# Phase 01 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: `01-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 5.0.2 with `@effect/vitest` (`it.effect`, `assert`) |
| **Config file** | root `vitest.config.ts`; `packages/cli/vitest.config.ts` (`name: "cli"`) |
| **Quick run command** | `npx vitest run --project cli` (about 3 s) |
| **Full suite command** | `pnpm test` (about 2 m 05 s) |
| **Estimated runtime** | about 9 minutes for the full phase gate |

---

## Sampling Rate

- **After every task commit:** `npx vitest run --project cli` and `npx tsc -b tsconfig.json && npx tsc -p tsconfig.test.json`
- **After every plan wave:** add `pnpm circular`, `pnpm lint`, `pnpm format:check`, `pnpm check:error-tags`, `pnpm check:transactions`
- **Before `/gsd-verify-work`:** `pnpm test`, `pnpm test:bdd`, `pnpm coverage`, `pnpm spec:verify:strict`, `pnpm knip` compared with `01-BASELINE.md`, `pnpm package:smoke` after `pnpm clean && pnpm build`
- **Max feedback latency:** 15 seconds per task

---

## Per-Task Verification Map

| Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|-----------|-------------------|-------------|--------|
| CLI-02 | Matrix pins pre-refactor output: views x text / `--format json` / `--json` / dot / dot+`--json`, selector precedence, one-document rule | unit | `npx vitest run --project cli packages/cli/test/PluginViews.test.ts` | ✅ | ✅ green |
| CLI-01 | Same matrix passes unchanged after the views module; `Inspection.test.ts` unchanged | unit | the command above plus `npx vitest run --project cli packages/cli/test/Inspection.test.ts` | ✅ | ✅ green |
| CLI-03 | `config list` text and `--json` bytes unchanged; no secret leaks | unit | `npx vitest run --project cli packages/cli/test/Doctor.test.ts` | ✅ | ✅ green |
| CLI-03 | `ConfigList` gone from export and tree | grep | `grep -rn "ConfigList" packages spec docs examples features .changeset --exclude-dir=node_modules --exclude-dir=lib` returns only the changeset's `Migration:` prose | n/a | ✅ green |
| CLI-03 | Spec Revision matches Change History | gate | `pnpm spec:verify:strict` | ✅ | ✅ green |
| CLI-04 | `openapi` stdout identical under text and `--json`; `Migration.apply` documents unchanged | unit | `npx vitest run --project cli packages/cli/test/Inspection.test.ts packages/cli/test/Migration.test.ts` | ✅ | ✅ green |
| GATE-01 | All gates match the baseline | gates | rows in `01-BASELINE.md`, re-run in `01-04-SUMMARY.md` | ✅ | ✅ green |
| GATE-02 | knip baseline recorded before any code change | doc | `01-BASELINE.md` exists and is committed first (`96c29821`, before `6dc0658f`) | ✅ | ✅ green |
| GATE-03 | Changeset with `Migration:` line; Revision and Change History bumped together | file check | `grep -l "^Migration:" .changeset/*.md`; `pnpm spec:verify:strict` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `.planning/phases/01-cli-views-and-configlist-removal/01-BASELINE.md` — gate table, raw `pnpm knip` output, `git status --short` and `git diff --stat knip.json` at capture time (GATE-02)
- [x] `packages/cli/test/PluginViews.test.ts` — matrix, committed green BEFORE any `src/` change (CLI-02)
- [x] a pre-refactor `openapi` parity case (text stdout equals `--json` stdout)

---

## Manual-Only Verifications

All phase behaviors have automated verification.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-11-14 (audit run after execution; Postgres-gated tests not run locally, none apply to this phase)

## Validation Audit 2026-11-14

| Metric | Count |
|---|---|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |
