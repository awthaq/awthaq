---
phase: 07-world-scaffold-and-credentials-split-optional
reviewed: 2026-11-15T00:00:00Z
depth: deep
files_reviewed: 13
files_reviewed_list:
  - packages/server/src/Credentials.ts
  - packages/server/src/internal/CredentialResolvers.ts
  - packages/server/src/internal/Presented.ts
  - packages/server/src/internal/PrincipalResolver.ts
  - packages/server/src/internal/Resolution.ts
  - packages/server/src/internal/Scopes.ts
  - packages/server/test/CredentialsSurface.test.ts
  - features/step-definitions/shared/EventCapture.ts
  - features/step-definitions/shared/EventCapture.types.ts
  - features/step-definitions/AdminWorld.ts
  - features/step-definitions/PasswordWorld.ts
  - features/step-definitions/DomainWorld.ts
  - features/features/_guard/world-table.steps.test.ts
findings:
  critical: 0
  warning: 3
  info: 3
  total: 6
  necessity: 1
status: issues_found
---

# Phase 7: Code Review Report

**Reviewed:** 2026-11-15
**Depth:** deep
**Files Reviewed:** 13
**Status:** issues_found

## Summary

No blockers. The Credentials split is verbatim: a sorted line-multiset diff of `git show ee8b80a1:packages/server/src/Credentials.ts` against the facade plus the five internal modules differs only by the new `import`/`export ... from` lines, the new header comments, and one `export` keyword on `resolveClaimed` (needed so `Scopes.ts` can import it; reachable only through `internal/`, not through the `exports` map or the facade). The three memo WeakMaps (`sessionMemo`, `claimMemo`, `outages`), `once`, `annotatePrincipal`, `principalFields` and `make` all live together in `Resolution.ts`. The import graph is acyclic (`Resolution` -> `PrincipalResolver`, types from `CredentialResolvers`/`Presented`; `Scopes` -> `CredentialResolvers`, type from `Resolution`). The only module-level side effects (`userTier`/`optionalTier`/`machineTier`, `tier(Api.*, ...)`) still run after the same `@awthaq/api` import. The facade has no `export *`, uses `export type` for the 12 type-only names and value exports for the 18 runtime names (counted: 4+8+11+5+2 = 30, equal to `07-CRED-SURFACE-BEFORE/AFTER.txt`, which are byte-identical). `CredentialsSurface.test.ts` and the guard pass when run.

`captureEvents` is behaviour-identical to the three removed inline layers: same `Layer.effectDiscard` + `stream` + `Stream.runForEach` + `Ref.update` append + `Effect.forkScoped({ startImmediately: true })`, same layer position (`taps` in Admin, `services` in Password and Domain), per-call construction as before. The only structural delta is an always-true `Stream.filter` in the two unfiltered adopters, which adds no async boundary before the subscription. AdminWorld passes the same `AuthEvents.is(worldEvents)` guard it used inline. The recorded ADOPTION-DELTA counts (Admin 22/3, Domain 14/2) match the diff.

The findings are about guard strength and requirement wording, not behaviour. The necessity rubric was read from the worktree copy (`.claude/gsd-core/references/necessity-review.md`). One attempted read of the same file via the other checkout's path was denied by the permission layer and returned nothing.

## Warnings

### WR-01: WORLD-02 / ROADMAP wording narrowed the gate without saying so, and the bookkeeping is stale

**File:** `.planning/REQUIREMENTS.md:60-61,134-136`, `.planning/ROADMAP.md` (Phase 7 Goal line)
**Issue:** D-03 and the original WORLD-02 promised "omitting a *plugin* from a scaffolded World is still a compile error". Plan 07-05 measured that dropping `Password.Password` from the `Auth.make` tuple stays green (recorded "as found" in `07-05-SUMMARY.md`, `07-07-SUMMARY.md`); only omitting a required *service* (`NoBreachHttpClient` in DomainWorld, red at `DomainWorld.ts:280` `TestAuth.serve`) fails. The requirement was rewritten to the narrower, true claim, but neither REQUIREMENTS.md nor ROADMAP.md says that the stronger claim was dropped or that plugin-drop is green. The measured claim also rests on one World (Domain) and one mutation that additionally produced TS6133 (unused constant), and the gate is not pinned by any committed artifact: `EventCapture.types.ts` pins that the helper does not widen the requirement, not that a scaffolded World fails to compile with a service missing. Separately: the ROADMAP Phase 7 **Goal** still says Worlds "use one scaffold over `TestAuth.layer`" while criterion 1 and WORLD-01 say "composing with, not re-wrapping"; and WORLD-01/02/CRED-01 are still `[ ]` / `Pending` although 7/7 plans are marked executed.
**Failure scenario:** a later reader (or the milestone report) trusts "the missing-plugin compile gate is kept" from D-03 or the Goal text, drops a plugin from a scaffolded World, and gets no compile error.
**Fix:** state in WORLD-02 (one clause) that dropping a plugin from the tuple is not a compile error and never was; align the Goal sentence to "composes with `TestAuth.layer`"; flip the three requirement rows and checkboxes at milestone close.

### WR-02: World-table guard is heuristic in both directions

**File:** `features/features/_guard/world-table.steps.test.ts:67-81`
**Issue:** Comment stripping removes only whole-line `//` comments (`^\s*\/\/.*$`). (a) False positive: a `/** ... authEvents.stream ... */` block, or `foo.stream`/`response.stream` unrelated to the bus, in a scaffolded World trips the `.stream` rule. (b) False negative on the import rule: `code.includes("./shared/EventCapture.ts")` is satisfied by the path text inside a block comment or a trailing `// ./shared/EventCapture.ts`, so a `no-tail` World that only mentions the file reads as "imports". (c) Presence of an import is taken as adoption: nothing asserts `captureEvents(` is called; a scaffolded World that imports it and re-adds a capture through `authEvents.subscribe` or `.on(` (the `.stream` regex is the only inline detector) passes. In (c) tsc's unused-import error is the only backstop. (d) `WORLDS` can drift from `07-WORLD-TABLE.md` (intended, but nothing flags it).
**Failure scenario:** an adopter keeps its old `subscribe`-based capture beside an unused-but-referenced import and the guard stays green; or a doc comment containing `.stream` on a scaffolded World breaks the build for a non-reason.
**Fix:** match the call, not the path: `/\bcaptureEvents\(/.test(code)` for `scaffolded`, and strip block comments too (`source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")`); widen the inline-subscriber check to `/\.(stream|subscribe|on|onBatch)\b/` for `scaffolded` Worlds.

### WR-03: CredentialsSurface pin proves type-name presence only, not a frozen surface

**File:** `packages/server/test/CredentialsSurface.test.ts:5-18`
**Issue:** The runtime half is exact (`Object.keys(...).sort()` deepEqual, 18 names). The type half is `export type { 12 names } from "../src/Credentials.ts"`, which fails only if one of those names disappears. A newly exported type (for example `Failure`, or any internal type leaked into the facade) and any change to a type's shape (a field added to `Rotation`, `Scope`, `Resolved`) pass. The header says the file "pins ... its type names at compile time", and the phase goal is "public namespace frozen". The exact-30 claim was proven once with a one-off TypeScript-API probe (`07-CRED-SURFACE-*.txt`), which is not part of any gate.
**Failure scenario:** a future edit adds `export type { Failure }` to `Credentials.ts`, or widens `Scope`, and CI stays green while the public d.ts changes.
**Fix:** state in the header that shape and extras are not pinned (so nobody reads it as a freeze), and if a real freeze is wanted add a compile-time exactness check, for example `type Names = keyof typeof Credentials` plus an `Exact<..., ...>` assertion over `typeof import("../src/Credentials.ts")`'s type exports via a small `.d.ts`-shape test.

## Info

### IN-01: Stale and inconsistent comments in the internal modules

**File:** `packages/server/src/internal/PrincipalResolver.ts:13`, `Resolution.ts:1`, `Scopes.ts:1`
**Issue:** `PrincipalResolver.ts:13` still reads "the principal resolver and the claimed-credential registry (moved from Authentication.ts)" but the registry now lives in `CredentialResolvers.ts`. `Resolution.ts` and `Scopes.ts` start without the `// @awthaq/server — internal X` header the other three internal modules use.
**Fix:** reword the section comment to the resolver alone; use the same header shape in all five.

### IN-02: Helper keeps `stream` + `startImmediately` while core documents `subscribe` as the race-free attach, so OrganizationWorld stays an unmerged duplicate

**File:** `features/step-definitions/shared/EventCapture.ts:1-14,29-33`, `features/step-definitions/OrganizationWorld.ts:119-131`
**Issue:** `AuthEvents.subscribe` (ALF-007, `packages/core/src/AuthEvents.ts:95-102`) registers the subscription at layer build and is the documented race-free way; `stream` is documented as lazy, and `startImmediately` is a workaround that depends on the fork running synchronously to its first suspension. D-11 and the helper comment ("a different semantic, ... do not finish the migration") overstate the difference: the observable capture is the same. Building the helper on `subscribe` would remove the race by construction, make OrganizationWorld a fourth adopter, and let the guard's `no-tail` label stop being wrong for a World that has a capture tail (the table acknowledges this under row 17 but the vocabulary says "nothing repeated to delete"). Changing it now would alter timing semantics in three Worlds, so this is a design note, not a defect.
**Fix:** record as a follow-up, or add a comment pointing at `subscribe` as the preferred primitive if the helper is ever touched.

### IN-03: Type-pin claims 1 and 3 mostly restate existing guarantees (necessity)

**File:** `features/step-definitions/shared/EventCapture.types.ts:15-20,32-43`
**Category:** necessity
**Issue:** Claim 1 (`needsOnlyAuthEvents`) reads the declared `Capture` alias; 07-04-SUMMARY measured that an implementation that reads another service is rejected inside `EventCapture.ts` by that same annotation, so the pin catches only a widening of the alias itself. Claim 3 (`foreignTapDoesNotLaunch`) goes red because of `Undeclared.tap` alone; it re-proves the guarantee already pinned for `TestAuth.layer` in `packages/test/test/TestAuthRecords.types.test.ts:31-41`, and only shows the helper in the merged `taps` is not `any`-typed. Claim 2 (`stillClosed`) is the one claim that exercises the helper in composition. Evidence the states are covered elsewhere: the compiler check on the annotation and the Phase 2 pin above. Rests on judgment about how much redundancy is wanted, hence Info.
**Fix:** none required; keep claim 2 and 1, optionally drop 3 or note it as a positive control for claim 2.

---

_Reviewed: 2026-11-15_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
