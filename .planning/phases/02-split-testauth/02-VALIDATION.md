---
phase: "02"
slug: "split-testauth"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-14"
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: `02-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 5.0.2 with `@effect/vitest` (`it`, `it.effect`, `assert`) |
| **Config file** | root `vitest.config.ts` (`projects`); `packages/test/vitest.config.ts` (`name: "test"`, `include: ["test/**/*.test.ts"]`) |
| **Quick run command** | `npx vitest run --project test` (measured: 33 files, 627 passed, 1 expected fail, about 12 s) |
| **Census quick run** | `npx vitest run --project core packages/core/test/SignInSeams.test.ts packages/core/test/RequestContextSeams.test.ts` (measured: 17 passed, under 1 s) |
| **Full suite command** | `pnpm test` (Phase 1 close: 410 files passed, 4 skipped; 6484 passed, 1 expected fail, 15 skipped) |
| **Estimated runtime** | about 10 minutes for the full phase gate |

---

## Sampling Rate

- **After every extraction commit:** `npx tsc -b tsconfig.json && npx vitest run --project test && npx vitest run --project core packages/core/test/SignInSeams.test.ts packages/core/test/RequestContextSeams.test.ts`
- **After every plan wave:** add `npx tsc -p tsconfig.test.json`, `pnpm circular`, `pnpm lint`, `pnpm format:check` (run `npx oxfmt` on new files first), `pnpm check:contract-tests`
- **Before `/gsd-verify-work`:** the full Phase 1 gate list compared with Phase 1's close table (`01-04-SUMMARY.md`), plus the Phase 2 additions in `02-RESEARCH.md`
- **Max feedback latency:** 15 seconds per task for the quick loop

---

## Per-Task Verification Map

| Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|-----------|-------------------|-------------|--------|
| TEST-01 | Exported name set identical before and after | probe diff, runtime pin, typecheck | `diff 02-SURFACE-BEFORE.txt 02-SURFACE-AFTER.txt`; `npx vitest run --project test packages/test/test/TestAuthSurface.test.ts`; `npx tsc -b tsconfig.json && npx tsc -p tsconfig.test.json` | ❌ W0 | ⬜ pending |
| TEST-01 | Four modules under `internal/`; the facade only re-exports by name | structural | `ls packages/test/src/internal/{composition,session,appHarness,contractRunner}.ts`; `grep -c "^export \*" packages/test/src/TestAuth.ts` is 0; `pnpm circular` | after implementation | ⬜ pending |
| TEST-01 | No file outside the allowlist edited | diff check | `git diff --name-only <phase-base>..HEAD` only under `packages/test/`, the two core census tests, `spec/`, `.planning/` | after implementation | ⬜ pending |
| TEST-02 | `buildContext` exported; `migratedSchema` reaches `TestSql.schemaOf` | unit | `npx vitest run --project test packages/test/test/TestAuthApp.test.ts`; the 13 `Schema.lock` tests via `pnpm test`; one `TestSql.schemaOf` hit in `internal/contractRunner.ts` | ✅ | ⬜ pending |
| TEST-03 | Counter beside `serve`/`openApps`; accounting unchanged | unit and BDD | `npx vitest run --project test packages/test/test/TestAuthLifetime.test.ts packages/test/test/TestAuthLazy.test.ts packages/test/test/TestAuthListen.test.ts`; `openAppCount` appears only in `internal/appHarness.ts`; `pnpm test:bdd` (LeakGuard `afterAll`) | ✅ | ⬜ pending |
| TEST-04 | Spec cites the new locations, test names kept, strict verify passes | spec gate | `pnpm spec:verify:strict`; `grep -rn "src/TestAuth.ts" spec` lists only intended facade mentions; `test -f` for each newly cited path (check 10 does not verify the `@awthaq/test/src/...` form) | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `02-SURFACE-BEFORE.txt` — probe output of the 47-name surface (the probe script is not committed as `.cjs`/`.mjs`: knip)
- [ ] `packages/test/test/TestAuthSurface.test.ts` — runtime key pin of the 23 value exports, green before any `src` change
- [ ] Re-record the `packages/test` project baseline (33 files, 627 passed, 1 expected fail) and the census pair (2 files, 17 passed)
- [ ] No framework install needed

---

## Manual-Only Verifications

All phase behaviors have automated verification. Postgres-gated cases (`TestAuthHost.test.ts`, the contract runner's Postgres parity case) cannot run locally (`AWTHAQ_POSTGRES_URL` unset); record "not run locally".

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
