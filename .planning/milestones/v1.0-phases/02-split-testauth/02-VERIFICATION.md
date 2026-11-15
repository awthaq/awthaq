---
phase: 02-split-testauth
verified: 2026-11-14T06:10:00Z
status: passed
score: 4/4 must-haves verified
covered_files:
  - ".planning/phases/02-split-testauth/02-01-PLAN.md"
  - ".planning/phases/02-split-testauth/02-01-SUMMARY.md"
  - ".planning/phases/02-split-testauth/02-02-PLAN.md"
  - ".planning/phases/02-split-testauth/02-02-SUMMARY.md"
  - ".planning/phases/02-split-testauth/02-03-PLAN.md"
  - ".planning/phases/02-split-testauth/02-03-SUMMARY.md"
  - ".planning/phases/02-split-testauth/02-04-PLAN.md"
  - ".planning/phases/02-split-testauth/02-04-SUMMARY.md"
  - ".planning/phases/02-split-testauth/02-05-PLAN.md"
  - ".planning/phases/02-split-testauth/02-05-SUMMARY.md"
  - "packages/core/test/RequestContextSeams.test.ts"
  - "packages/core/test/SignInSeams.test.ts"
  - "packages/test/src/TestAuth.ts"
  - "packages/test/src/internal/appHarness.ts"
  - "packages/test/src/internal/composition.ts"
  - "packages/test/src/internal/contractRunner.ts"
  - "packages/test/src/internal/foundation.ts"
  - "packages/test/src/internal/session.ts"
  - "packages/test/test/TestAuthSurface.test.ts"
covered_digest: "v4:sha256:53dfae4e7a6683d958591c41acda4b02a1c833d0033beb80ff3e643abe43720a"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "no consumer file outside packages/test needs an edit"
    reason: "Four `file:` string literals in packages/core/test/SignInSeams.test.ts and RequestContextSeams.test.ts were retargeted (test/src/TestAuth.ts -> internal/composition.ts / internal/session.ts). These are source-text census tests that import nothing from TestAuth; they key per-file construct counts by path, so moving the counted constructs necessarily moves the key. Decided in 02-CONTEXT.md (Census tests) and disclosed in the plan; counts unchanged."
    accepted_by: "02-CONTEXT.md discuss-phase decision (developer-selected option); ROADMAP criterion 1 wording not yet amended"
    accepted_at: "2026-11-14"
---

# Phase 2: Split TestAuth Verification Report

**Phase Goal:** `packages/test/src/TestAuth.ts` is a thin facade over concern-scoped modules, with the exported surface and leak accounting untouched.
**Verified:** 2026-11-14
**Status:** passed
**Re-verification:** No, initial verification

## Goal Achievement

### Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Exported `TestAuth.*` name set identical before/after; no consumer outside `packages/test` needs an edit | VERIFIED (with disclosed narrowing, PASSED override) | `diff 02-SURFACE-BEFORE.txt 02-SURFACE-AFTER.txt` is empty (176 lines each). Independently: original export names (git show d4282e31) equal the facade's names; `TestAuthSurface.test.ts` pins 23 values at runtime (re-run: 1 passed) and 24 types at compile time (`tsc -p tsconfig.test.json`: 0 `error TS`). `git diff --stat d4282e31 HEAD` outside `.planning`/`spec`/`.claude` touches only `packages/test/**` plus two core test files. See "Disclosed narrowing" below. |
| 2 | `internal/` holds separate composition, session, app harness and contract runner modules; `buildContext` still exported; `migratedSchema` still calls `TestSql.schemaOf` | VERIFIED | `packages/test/src/internal/{composition 328, session 140, appHarness 424, contractRunner 905}.ts` (+ `foundation.ts`). `TestAuth.ts` is 129 lines: header comments plus named re-exports only, defines nothing. `buildContext` defined at `appHarness.ts:418`, re-exported by the facade and in the pin test's 23 values. `contractRunner.ts:201`: `const shape = yield* TestSql.schemaOf;`. Line-level comparison: only 18 distinct original lines are absent from the new files and all are imports or header-comment lines. |
| 3 | Open-app counter beside `serve`/`openApps`; `LeakGuard` accounting unchanged; existing LeakGuard tests and Schema.lock files pass unedited | VERIFIED | `openAppCount` occurs only in `appHarness.ts` (lines 113, 114, 149, 247; the `lib/` hits are build output). The `make` block (increment before `toWebHandler`, decrement last in `release`) is byte-identical to the original lines 626-775 apart from block boundaries (diffed). `Schema.lock.test` run: 13 files / 13 tests pass; none edited since d4282e31 (`git diff --stat` empty). LeakGuard-dependent tests (`TestAuthLifetime`, `TestAuthLazy`, `TestAuthListen`, `features/.../LeakGuard.ts`, `TestingHarnessComposeSteps.ts`) unedited. |
| 4 | `spec/behaviors/25-testing-harness.md` and `spec/traceability.md` cite new locations, test file names kept; `spec:verify:strict` passes | VERIFIED | Spec diff vs d4282e31: 25-testing-harness.md Implementation lines now cite `internal/composition.ts`, `internal/appHarness.ts` (x3), test file names unchanged; traceability.md row 51 cites facade over the four modules, rows for Lifetime/Lazy/Listen now cite `internal/appHarness.ts`, new `TestAuthSurface.test.ts` row added; invariants.md cites `internal/contractRunner.ts`. `bash spec/scripts/verify-traceability.sh --strict`: `PASS: 32 FAIL: 0 SKIP: 0`. |

**Score:** 4/4 truths verified (0 behavior-unverified). Truth 3's accounting invariant is a state-transition truth; its behavioral evidence is the unedited, passing `TestAuthLifetime`/`TestAuthLazy`/`TestAuthListen` tests (in the `test` project run) plus the byte-identical counter code.

### Disclosed narrowing of ROADMAP criterion 1

ROADMAP criterion 1 literally says "no consumer file outside `packages/test` needs an edit". Four string literals in two files outside `packages/test` were edited:

- `packages/core/test/SignInSeams.test.ts` (2 literals): `test/src/TestAuth.ts` -> `test/src/internal/session.ts`
- `packages/core/test/RequestContextSeams.test.ts` (2 literals): -> `internal/composition.ts` and `internal/session.ts`

These files import nothing from `TestAuth`; they read source text and key construct counts by path, so any split relocating the counted constructs (`sessions.issue(`/`users.create(` in `signInAs`, `ClientAddress.ClientAddress` x2, `AuthRequestContext.noRequest`) forces the path keys to follow. The counts, `why` strings and logic are unchanged and both files pass (17/17). Recorded as a PASSED (override) rather than a silent pass; the ROADMAP/REQUIREMENTS wording was not amended and should be (see Notes). Likewise ROADMAP/CONTEXT say 12 Schema.lock tests; the tree has 13 (12 under `packages/*/test` plus the plugin-template example). All 13 pass unedited.

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `packages/test/src/TestAuth.ts` | VERIFIED | 129-line facade, named re-exports, no definitions |
| `packages/test/src/internal/composition.ts` | VERIFIED | 328 lines, test ports/guard/`layer` |
| `packages/test/src/internal/session.ts` | VERIFIED | 140 lines, request facts, session/CSRF minting |
| `packages/test/src/internal/appHarness.ts` | VERIFIED | 424 lines, serve/listen/withApp/lazyApp/buildContext/counter |
| `packages/test/src/internal/contractRunner.ts` | VERIFIED | 905 lines, `runPluginContractTests`, `migratedSchema` |
| `packages/test/src/internal/foundation.ts` | VERIFIED | `memoryFoundation`, shared with `RecordsContract` |
| `packages/test/test/TestAuthSurface.test.ts` | VERIFIED | Surface pin, passes |

### Key Link Verification

| From | To | Status | Details |
|------|----|--------|---------|
| `TestAuth.ts` | four concern modules + foundation | WIRED | every public name re-exported from the internal module defining it |
| `migratedSchema` | `TestSql.schemaOf` | WIRED | `contractRunner.ts:201` |
| census tests | new file paths | WIRED | 17/17 pass with new `file:` keys |
| spec docs | new module paths | WIRED | strict traceability passes |

### Behavioral Spot-Checks and Gates (run by the verifier)

| Check | Command | Result |
|-------|---------|--------|
| Build | `npx tsc -b tsconfig.json` | exit 0, no output |
| Tests typecheck (pins the 24 types) | `npx tsc -p tsconfig.test.json` | 0 `error TS` |
| Cycles | `pnpm circular` | exit 0 |
| Surface pin | `npx vitest run packages/test/test/TestAuthSurface.test.ts` | 1 passed |
| Census pair | `npx vitest run --project core .../SignInSeams.test.ts .../RequestContextSeams.test.ts` | 2 files, 17 tests passed |
| Schema.lock | `npx vitest run Schema.lock.test` | 13 files, 13 tests passed |
| `test` project | `npx vitest run --project test` | 33/34 files on two default runs (see Anti-patterns/Notes: `StoreContract.test.ts` sql-mode case hit the 5000 ms default timeout under machine load average ~50); with `--testTimeout=30000`: 34 files passed, 628 passed, 1 expected fail |
| Spec | `bash spec/scripts/verify-traceability.sh --strict` | PASS 32, FAIL 0, SKIP 0 |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| TEST-01 | split into internal/ modules, facade, identical name set | SATISFIED | Truths 1-2 |
| TEST-02 | `buildContext` kept; `migratedSchema` calls `TestSql.schemaOf` | SATISFIED | Truth 2 |
| TEST-03 | open-app counter beside serve/openApps; LeakGuard accounting unchanged | SATISFIED | Truth 3 |
| TEST-04 | spec cites new locations, test file names kept | SATISFIED | Truth 4 |

No orphaned requirements: REQUIREMENTS.md maps TEST-01..04 to Phase 2 and all four are claimed by plans.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | `TBD`/`FIXME`/`XXX`/`TODO`/`HACK` scan of the five modified source files | - | none |
| `packages/test/test/StoreContract.test.ts` | 166 | sql-mode case times out at 5000 ms in a loaded full `test` project run | Info | Not a phase gap: file and `StoreContract` sources are unedited since d4282e31 (diff empty); passes in isolation (9/9) and in full run with a 30 s timeout; the host was at load average ~50 from unrelated processes. Baseline run (02-BASELINE.md) was 7 s total vs 14-17 s here. |

### Human Verification Required

None. Postgres-gated tests (`TestAuthHost.test.ts` under `pnpm test:pg`, `Migration.postgres.test.ts`) are not run locally, which is expected.

### Gaps Summary

No gaps. The one literal deviation (criterion 1's "no consumer edit") is an explicit, documented, developer-decided narrowing limited to four path-string literals in non-importing census tests; it is carried as an override above.

### Notes for the orchestrator

- Recommend amending ROADMAP criterion 1 and REQUIREMENTS wording to allow the two core census tests' `file:` path literals, and correcting "12 Schema.lock tests" to 13, so the contract matches what shipped.
- Full `pnpm test` / coverage / knip / package:smoke were not re-run by the verifier (baseline in 02-BASELINE.md; per the instructions only the listed gates were run).

---

_Verified: 2026-11-14_
_Verifier: Claude (gsd-verifier)_
