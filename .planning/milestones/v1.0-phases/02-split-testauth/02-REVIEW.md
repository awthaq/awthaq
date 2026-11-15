---
phase: 02-split-testauth
reviewed: 2026-11-14T00:00:00Z
depth: standard
files_reviewed: 13
files_reviewed_list:
  - packages/test/src/TestAuth.ts
  - packages/test/src/internal/composition.ts
  - packages/test/src/internal/session.ts
  - packages/test/src/internal/appHarness.ts
  - packages/test/src/internal/contractRunner.ts
  - packages/test/src/internal/foundation.ts
  - packages/test/test/TestAuthSurface.test.ts
  - packages/core/test/SignInSeams.test.ts
  - packages/core/test/RequestContextSeams.test.ts
  - spec/behaviors/25-testing-harness.md
  - spec/traceability.md
  - spec/invariants.md
findings:
  critical: 0
  warning: 0
  info: 1
  total: 1
  necessity: 0
status: clean
---

# Phase 2: Code Review Report

**Reviewed:** 2026-11-14
**Depth:** standard (plus cross-file pass)
**Status:** clean (no Critical or Warning findings; one Info)

## Summary

Behaviour-preserving split of `TestAuth.ts` verified against `git show d4282e31:packages/test/src/TestAuth.ts`.

1. Verbatim move: a whitespace-trimmed line multiset comparison (original vs. composition + session + appHarness + contractRunner + facade) leaves only import lines, the new facade export lines, the module header comments, the `export` keyword on `makeLayer` (reflowed signature), and the intended header-comment edit ("wired in below" -> "wired in `internal/composition.ts`"). No line is lost or duplicated. A sequential diff of the original body against the concatenated modules shows only whole blocks relocated (`withRequest`/`withoutRequest` to session.ts; `encryption`/`httpClient` after `layer` in composition.ts; `FoundationServices`/`RetentionRegistryService` to foundation.ts; `export type { TestFramework }` and the conformance re-exports to the facade). Doc comments the spec cites (the `signInAs`/`HttpApiTest.groups` and `@qadi/testing` header paragraphs) remain in `TestAuth.ts:39-54` and `:18-23`.
2. Open-app counter: `let openAppCount` (appHarness.ts:113), `openApps = () => openAppCount` (:114, live read), `++` at :149, `--` at :247. No other module references it.
3. `migratedSchema` still does `yield* TestSql.schemaOf` (contractRunner.ts:201); `buildContext` is exported from appHarness.ts:418 and re-exported at TestAuth.ts:96.
4. No import cycle: no `internal/*` module imports `../TestAuth.ts`; edges are appHarness -> session, contractRunner -> composition, foundation; composition -> foundation-free leaves. `node scripts/circular.mjs` reports nothing.
5. Surface: `02-SURFACE-BEFORE.txt` and `02-SURFACE-AFTER.txt` are byte-identical; `TestAuthSurface.test.ts` lists 23 values and 24 types, both counts match the facade's exports (the 24 type names were counted by hand).
6. Module-init order: every module-level value (`TestHasher`, `GuardLive`, `TestCsrfConfig`, `recordModes`, `encryption`, `httpClient`/`clientReturning`, `let openAppCount`, `EVENT_SAMPLES`, `TABLE_PREFIX_PATTERN`) is pure construction with no cross-module dependence at import time. The one relocation (`encryption`/`httpClient` below `layer`) is not referenced by any initialiser above it. No behaviour change.
7. Spec: Revisions (25-testing-harness 1.15->1.16, traceability 1.89->1.90, invariants 1.9->1.10) each have a matching Change History row and Effective Date 2026-11-14. Cited paths and the cited check text ("every declared table carries this plugin's own id prefix", contractRunner.ts:536) exist. `bash spec/scripts/verify-traceability.sh --strict`: 32 PASS, 0 FAIL. The four `file:` literals in the two core seam tests match what the census actually counts (both tests pass).

Gates re-run in this review: `tsc -p tsconfig.test.json` (0 errors, 2 pre-existing TS377149 warnings), `packages/test` vitest (34 files, 628 passed, 1 expected fail), core `SignInSeams` and `RequestContextSeams` (17 passed), `oxfmt --check` clean, `oxlint packages/test` clean, `knip` has no `packages/test` rows (only the known `.claude/` and readme-quickstart ones).

## Info

### IN-01: `traceability.md` Change History jumps from 1.22 to 1.90

**File:** `spec/traceability.md:13`
**Issue:** The new `1.90` row is appended after `1.22`; rows 1.23..1.89 do not exist (the same gap is already present at the base, where Revision was 1.89 with history ending at 1.22). This phase did not create the gap and bumped consistently from the displayed Revision, so nothing here is wrong, but "Revision numbers and Change History rows are consistent" holds only relative to the Revision field, not to a continuous history.
**Fix:** None required for this phase; optionally note it for the next doc sweep.

---

_Reviewed: 2026-11-14_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
