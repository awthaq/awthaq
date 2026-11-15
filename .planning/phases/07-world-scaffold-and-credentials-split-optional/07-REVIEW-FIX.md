---
phase: 07-world-scaffold-and-credentials-split-optional
fixed_at: 2026-11-15T00:00:00Z
review_path: .planning/phases/07-world-scaffold-and-credentials-split-optional/07-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 5
skipped: 0
status: partial
---

# Phase 7: Code Review Fix Report

**Fixed at:** 2026-11-15
**Source review:** `.planning/phases/07-world-scaffold-and-credentials-split-optional/07-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (WR-01, WR-02, WR-03, IN-01, IN-02, IN-03)
- Fixed: 5 (WR-01 code half, WR-02, WR-03, IN-01, IN-03)
- Investigated, no behaviour change by design: 1 (IN-02, evidence below; wording corrected)
- Skipped: 0

Verification ran in the main checkout (`/Users/mohammadalmechkor/Projects/Perso/awthaq-arch`), no extra worktree.

## Fixed Issues

### WR-01: missing-service compile gate pinned (code half only)

**Files modified:** `features/step-definitions/shared/EventCapture.types.ts`
**Commit:** 78bc0444 (shared with IN-03, same file)
**Applied fix:** added `completeServes` (positive control: `TestAuth.serve` of the complete composition compiles) and `missingServiceDoesNotServe` (`@ts-expect-error` on `TestAuth.serve` of a scaffolded composition whose `services` omit the breach `HttpClient`, the requirement `Password` has and DomainWorld satisfies with `TestAuth.httpClient.noBreach`). The header now states plugin-drop from the `Auth.make` tuple is not a compile error and never was.
**Coverage (measured):** the file is covered by the `features` project of `tsc -b tsconfig.json` only. `tsc -p tsconfig.test.json --listFilesOnly` does not list it (it includes `features/**/*.steps.test.ts`, not `step-definitions`), so the old header claim that `tsc -p tsconfig.test.json` is the assertion was wrong and is corrected. `tsc -p tsconfig.test.json` is still clean.
**Mutations (all restored, byte-identical, `tsc -b` clean afterwards):** add `noBreach` to the incomplete composition: `TS2578 Unused '@ts-expect-error'`; delete the `@ts-expect-error` line: `TS2379` at the `serve` argument (the layer still requires `HttpClient`); flip `stillClosed` to the wrong expectation: `TS2322`.
**Not done, by instruction:** the ROADMAP Goal wording, the WORLD-02 clause and the requirement checkboxes (`.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`) are the orchestrator's. The pin rests on one World's service (Domain's breach client), reproduced in a minimal composition rather than by duplicating a World.

### WR-02: world-table guard hardened

**Files modified:** `features/features/_guard/world-table.steps.test.ts`, `.planning/phases/07-world-scaffold-and-credentials-split-optional/07-WORLD-TABLE.md` ("Pinned by" wording)
**Commit:** 5957f3b8
**Applied fix:** a single-pass `stripComments` (strings and templates kept, line and block comments removed; a `shortcut:` comment names the limit: no regex-literal or nested-template support) replaces the whole-line `//` regex; scaffolded Worlds must call `captureEvents(` and must have no `.stream`, `.subscribe`, `.on` or `.onBatch` read; the import rule matches an `import ... from "./shared/EventCapture.ts"` statement, not the path text. Still one test file and one `it` (the bdd count is locked), with a stripComments self-check folded into that `it`. Point (d) (map vs table drift) was not changed: the guard deliberately never reads `.planning/`.
**Mutations (script `scratchpad/wr02-mut.sh`; every touched file restored from byte copies, `cmp` identical, no probe World left):** unclassified World (empty `ZzProbeWorld.ts`): red; misclassified (Admin to `no-tail` in the map): red; no-tail `JwtWorld` with a block comment quoting the import: green (the old guard flagged this); scaffolded Admin whose import is only a block comment: red; block-comment `.stream` in scaffolded Admin: green (old false positive gone); real `.subscribe` read in scaffolded Admin: red; import kept but call renamed away in Admin: red. Clean run before and after: 1 passed.

### WR-03: Credentials surface pin strengthened

**Files modified:** `packages/server/test/CredentialsSurface.test.ts`
**Commit:** c94715a5
**Applied fix:** the file no longer re-exports the 12 type names (that proved presence only). A second test reads the facade source, strips comments, collects every `export type { ... } from` list and asserts the exact 12 type names, then asserts nothing else in the file exports (no `export *`, no inline export). `Rotation`, `Scope` and `Resolved<UserPrincipal>` are frozen by `Equal` assertions (the repo's own `Equal`/`Expect` idiom) checked by `tsc -p tsconfig.test.json`. Type exactness is not expressible at type level without the compiler API, and TypeScript is 7.0.2 here (no JS API to import in a test), hence the text check with a `shortcut:` note; shapes of the other types are not pinned and the header says so. The runtime 18-name half is unchanged.
**Mutations (restored from byte copies, `src` diff empty):** `export type { Failure, ... }` plus `export type Failure`: vitest red (type-name set differs); an extra optional field on `Rotation`: `TS2344` at `RotationShape`; dropping `readonly` on `Resolved`'s Claimed `principal`: `TS2344` at `ResolvedShape`. Green on the current facade (97 tests across the three server Credentials files).

### IN-01: stale and inconsistent headers

**Files modified:** `packages/server/src/internal/Resolution.ts`, `packages/server/src/internal/Scopes.ts`, `packages/server/src/internal/PrincipalResolver.ts`
**Commit:** 18df9616
**Applied fix:** `Resolution.ts` and `Scopes.ts` now open with `// @awthaq/server — internal X` plus a one-line description (same form as the other three); the `PrincipalResolver.ts` section comment no longer names the claimed-credential registry. Comment-only. Re-ran the line-multiset check against `ee8b80a1:packages/server/src/Credentials.ts` over the facade and five modules: the delta is exactly the import/export lines, the `export` on `resolveClaimed` and comment lines.

### IN-03: redundant type claims removed (necessity)

**Files modified:** `features/step-definitions/shared/EventCapture.types.ts`
**Commit:** 78bc0444 (shared with WR-01)
**Applied fix:** deleted claim 1 (`needsOnlyAuthEvents`, restates the helper's own `Capture` annotation) and claim 3 (`foreignTapDoesNotLaunch`, with `Undeclared`, `HookPoint`, `Schema`, `Effect` imports; duplicates `packages/test/test/TestAuthRecords.types.test.ts:31-41`). Kept claim 2 (`stillClosed`) and added the WR-01 pin. Status: fixed, requires human verification (removes code, judgment on redundancy). Mutation evidence is the WR-01 set above: the kept claim and the new pin both go red under a wrong expectation.

## Investigated, no behaviour change

### IN-02: `AuthEvents.subscribe` is not a drop-in for `stream` + `startImmediately`

**Files modified (comment and doc only):** `features/step-definitions/shared/EventCapture.ts` (comment), `.planning/phases/07-world-scaffold-and-credentials-split-optional/07-WORLD-TABLE.md` (row 17)
**Commit:** 85c3315d
**Evidence:** in effect 4.1.2 both reduce to `PubSub.subscribe` + `fromSubscriptionArray` (`Stream.fromPubSub` = `unwrap(subscribe, fromSubscriptionArray)`), so chunking and event order are identical, and registration is effectively at build time in both (the eager fork reaches the subscribe before returning). Source reading alone therefore said "identical". The experiment disagreed. Helper on `subscribe` with a plain `forkScoped` (Organization's form): bdd 40 files, 5 failed, 1576 passed, 44 skipped; all five in `27-admin-impersonation` ("expected an impersonationStarted event"), because Admin's steps read the Ref without polling and the consumer fiber's first run is observable. Helper on `subscribe` with `forkScoped({ startImmediately: true })`: bdd 1581 passed, 44 skipped, 40 files, but it removes nothing, so no switch was made. The helper stays on `stream` (restored byte-identical from a copy; only its comment changed).
**Wording corrected:** the "different registration semantic" claim for OrganizationWorld was overstated. The registration is not the difference; the consumer's first run is. Whether Organization's steps tolerate the helper's timing was not measured and the World is out of scope, so it stays inline as the one remaining candidate fourth adopter. Edited: helper header comment and `07-WORLD-TABLE.md` row 17; the guard's header now says what `no-tail` means for OrganizationWorld (the guard has no per-World reason text). Not edited, as historical records: `07-CONTEXT.md` D-11, `07-RESEARCH.md` Pitfall 6/A8, `07-04-PLAN.md`, `07-BASELINE.md` line 310 still carry the old "different semantics" wording. `OrganizationWorld.ts` untouched.

## Verification (final tree, SQLite, main checkout)

- `tsc -b tsconfig.json`: clean. `tsc -p tsconfig.test.json`: no errors (only the existing warnings in `TestingHarnessSteps.ts`).
- `pnpm test:bdd`: 40 files, 1581 passed, 44 skipped; the 40 `[leak-guard]` lines are identical to the earlier run's.
- Server `CredentialsSurface`, `Credentials`, `CredentialResolvers` tests: 97 passed.
- `pnpm format:check`: clean (1242 files). `pnpm lint`: no finding in any touched file (existing warnings elsewhere). `pnpm circular`: exit 0.
- `pnpm knip`: 39 `.claude` unused-file rows and 3 `readme-quickstart` unlisted-dependency rows, nothing else (baseline).
- Postgres not re-run: no World or helper behaviour changed (the helper experiment was reverted to byte-identical before the commits; only comments changed). Credentials facade untouched, so the 30-name surface and probe diff are unchanged; no `as` added in `packages/*/src` (comment-only edits there).
- Allowlist: every touched path is already in the `07-BASELINE.md` path allowlist (`.planning/`, the helper, its types file, the guard, the internal modules, `CredentialsSurface.test.ts`); no line appended.

---

_Fixed: 2026-11-15_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
