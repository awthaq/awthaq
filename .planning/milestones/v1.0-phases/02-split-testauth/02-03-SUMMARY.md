---
phase: 02-split-testauth
plan: 03
subsystem: testing
tags: [testauth, session, csrf, app-harness, leak-guard, internal-modules, facade, census]

requires:
  - phase: 02-split-testauth
    provides: 02-02 internal/composition.ts and foundation type names behind the facade
provides:
  - packages/test/src/internal/session.ts, request-fact scoping and session/CSRF minting without HTTP (verbatim move, leaf module)
  - packages/test/src/internal/appHarness.ts, the app harness with the open-app counter beside every write to it (verbatim move)
  - TestAuth.ts re-exporting both modules by name
affects: [02-04, 02-05, phase-07]

actuals:
  tokens: 40000
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Mechanical line-range move via a throwaway script kept in the scratchpad, never committed"
    - "Counter and every write to it in one module; openApps stays a function over the module-level counter"

key-files:
  created:
    - packages/test/src/internal/session.ts
    - packages/test/src/internal/appHarness.ts
  modified:
    - packages/test/src/TestAuth.ts
    - packages/core/test/SignInSeams.test.ts
    - packages/core/test/RequestContextSeams.test.ts

key-decisions:
  - "The temporary local session import added by Task 1 sits in the facade's import block (not mid-file) so import ordering stays lint-clean; Task 2 deleted it as planned"

patterns-established:
  - "Import DAG for the facade split: appHarness -> session; composition and foundation untouched by both"

requirements-completed: [TEST-01, TEST-02, TEST-03]

duration: 12min
completed: 2026-11-14
status: complete
commits: 2
plan_head_before: 906f9aece4f330db1f1c86178b485d437d399cee
plan_head_after: 10638b69c61d319ece1bce246e05ba8cfac631f0
---

# Phase 2 Plan 03: Extract session/CSRF minting and the app harness Summary

**TestAuth's request-fact scoping, session and CSRF minting now live verbatim in internal/session.ts, and the app harness (serve, listen, withApp, lazyApp, buildContext) with the open-app counter lives verbatim in internal/appHarness.ts, both behind named facade re-exports.**

## Accomplishments

- `internal/session.ts` (leaf): withRequest, withoutRequest, SignedInSession, serialize (unexported), sessionSetCookie, signInAs, csrfToken, csrfSetCookie. Imports nothing relative.
- `internal/appHarness.ts`: RequestInit, AgentOptions, SignInOptions, SignedInAgent, App, AppNeeds, `openAppCount`, `openApps`, ServeOptions, make (unexported), serve, ListeningApp, listen, withApp, LazyApp, lazyApp, buildContext. Only relative import is `./session.ts`.
- `openAppCount` occurs exactly 4 times in `packages/test/src`, all in appHarness.ts; `openApps` is `() => openAppCount` over the same module's counter.
- `TestAuth.ts`: both regions removed; `export { csrfSetCookie, csrfToken, sessionSetCookie, signInAs, withRequest, withoutRequest }` + `export type { SignedInSession }` from session; `export { buildContext, lazyApp, listen, openApps, serve, withApp }` + the nine harness types from appHarness; unused imports dropped.
- Census (same commit as the session move): SignInSeams two `file:` literals and RequestContextSeams noRequest `file:` literal now `test/src/internal/session.ts`. `git diff --numstat d4282e31` reads `2 2` for each file (RequestContextSeams: composition key from 02-02 plus this one).

## Gate results

| Gate | Result |
|------|--------|
| `npx tsc -b tsconfig.json` | 0, after each commit |
| `npx tsc -p tsconfig.test.json` | 0 `error TS`, after each commit |
| `npx vitest run --project test` | 34 files passed; 628 passed, 1 expected fail (baseline), after each commit |
| census pair (SignInSeams, RequestContextSeams) | 2 files, 17 tests passed |
| TestAuthRequest, TestAuthSurface | 5 passed, unedited |
| TestAuthLifetime/Lazy/Listen/App (counter pins) | green (in the `test` project run), unedited since d4282e31 |
| `pnpm circular` | 0, after each commit |
| `pnpm test:bdd` (LeakGuard enforcing, after `tsc -b`) | 39 files passed; 1576 passed, 44 skipped (1620): equal to 02-BASELINE.md; every `[leak-guard]` line `apps=0 sqlClients=0` |
| `pnpm format:check` | all files correctly formatted |
| `pnpm lint` | warnings only under untracked `.claude/` (as baseline) |
| verbatim-move gate (session.ts, appHarness.ts) | 0 non-import code lines absent from TestAuth.ts at d4282e31, both files |
| counter gates | `grep -rl openAppCount packages/test/src` prints only appHarness.ts; occurrences 4 |
| Postgres-gated tests | not run locally |

All acceptance greps matched their EXPECT: session leaf (0 relative imports), census `file:` counts, `from "./internal/session.ts"` 2 lines and `from "./internal/appHarness.ts"` 2 lines in the facade, appHarness imports `./session.ts` once and never `./composition.ts`.

## Task Commits

1. **Task 1: extract internal/session.ts end to end** - `91335e8b` (refactor)
2. **Task 2: extract internal/appHarness.ts with the open-app counter** - `10638b69` (refactor)

## Deviations from Plan

None - plan executed exactly as written. (Facade line numbers differed from the d4282e31 probe because 02-02 had already removed earlier regions; regions were located with grep and moved by line range. The one placement choice, the temporary session import in the import block rather than after the re-exports, is recorded in key-decisions.)

## Issues Encountered

- First `tsc -b` after each move reported unused-import errors in TestAuth.ts and, for appHarness.ts, a missing `Redacted` import (the plan's import list did not name `effect/Redacted` for the harness; `lazyApp`/`make` use it). Resolved by trimming and adding the import, as the plan says tsc -b is the arbiter. No code line changed.
- The passkey ChallengeStore intermittent did not occur.

## Known Stubs

None.

## Threat Flags

None. T-02-06 mitigated (verbatim gate 0; census pins one `sessions.issue(` and one `users.create(` in session.ts; csrfToken HMAC unchanged). T-02-07 mitigated (counter gate 4 occurrences in one file; BDD counts equal baseline with LeakGuard enforcing).

## Self-Check: PASSED

- FOUND: packages/test/src/internal/session.ts
- FOUND: packages/test/src/internal/appHarness.ts
- FOUND commits 91335e8b, 10638b69
