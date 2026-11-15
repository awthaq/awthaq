---
phase: 07-world-scaffold-and-credentials-split-optional
verified: 2026-11-15T03:20:00Z
status: passed
score: 3/3 roadmap truths verified in code (WORLD-01, WORLD-02, CRED-01 satisfied as the aligned wording reads); 0 failed; 0 gaps; five judgement items and two bookkeeping items remain for a human; Postgres legs run locally on Debian postgres:16, CI confirmation open (no git remote)
covered_files:
  - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-01-PLAN.md
  - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-01-SUMMARY.md
  - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-02-PLAN.md
  - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-02-SUMMARY.md
  - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-03-PLAN.md
  - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-03-SUMMARY.md
  - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-04-PLAN.md
  - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-04-SUMMARY.md
  - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-05-PLAN.md
  - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-05-SUMMARY.md
  - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-06-PLAN.md
  - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-06-SUMMARY.md
  - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-07-PLAN.md
  - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-07-SUMMARY.md
  - features/features/_guard/world-table.steps.test.ts
  - features/step-definitions/AdminWorld.ts
  - features/step-definitions/DomainWorld.ts
  - features/step-definitions/PasswordWorld.ts
  - features/step-definitions/shared/EventCapture.ts
  - features/step-definitions/shared/EventCapture.types.ts
  - packages/server/src/Credentials.ts
  - packages/server/src/internal/CredentialResolvers.ts
  - packages/server/src/internal/Presented.ts
  - packages/server/src/internal/PrincipalResolver.ts
  - packages/server/src/internal/Resolution.ts
  - packages/server/src/internal/Scopes.ts
  - packages/server/test/CredentialsSurface.test.ts
covered_digest: "v4:sha256:6a28459297a880a44216bbbad8e46e82a8f0520b93c1642fbcb66a066ef9a870"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Accept WORLD-01 as 'composes with TestAuth.layer, not wraps it'"
    expected: "The user accepts that the requirement text was edited down from 'a scaffold ... that wraps TestAuth.layer ... supplies lazyApp, TestClock and capture layers' to a one-layer `captureEvents` helper that composes with `TestAuth.layer` and supplies only the AuthEvents capture layer, or asks for a wrapper after all"
    why_human: "The code does what the aligned wording says and the measurement behind the change is sound (lazyApp and TestClock are single TestAuth calls or options, a wrapper would restate TestAuth.layer's type parameters and overloads). But the requirement, the ROADMAP goal and criterion 1 were rewritten after the research to fit the result. Whether that is 'the goal achieved' or 'the goal shrunk' is a scope call the user owns."
  - test: "Judge the scaffold's size and keep-or-drop"
    expected: "Accept `captureEvents` (3 adopters) as kept for locality of the reproduced lost-publish race, or drop the helper and restore the inline copies"
    why_human: "Measured at HEAD: the three adopters lost 50 lines and gained 7; the helper is 48 lines (26 without comments or blanks), so net +5 lines with comments, not the +1 the close recorded (the helper grew from 44 to 48 lines when IN-02 added comment lines). It passes the deletion test (the inline subscriber vanishes from each World) but costs slightly more than it removes. D-05 said 'smaller scaffold plus a table, recorded not padded'; whether that net is worth the single home for the race fix is taste."
  - test: "IN-02: keep the helper on `AuthEvents.stream` + `startImmediately`, and leave OrganizationWorld inline and unmeasured"
    expected: "Accept that the helper stays on `stream` (the only form that passed with the Admin steps' timing and removed code) and that OrganizationWorld, which repeats the same capture body on `subscribe`, stays a recorded candidate fourth adopter whose tolerance of the helper's timing was never measured; or order the one measurement"
    why_human: "The code is correct and the experiment is recorded (helper on `subscribe` with a plain fork: 5 failures in 27-admin-impersonation; with `startImmediately`: green but removes nothing). The open part is a design call: the guard labels OrganizationWorld `no-tail` although it holds a capture of the same shape, which the table admits in row 17. Measuring costs one edit of OrganizationWorld and one bdd run; I did not do it because this verification may not edit source."
  - test: "Confirm accepted-risk rows AR-07-03, AR-07-04 and AR-07-05"
    expected: "AR-07-03: nine exported Credentials types (Carrier, ClaimCarrier, CredentialResolverContribution, CredentialResolversShape, Presented, PrincipalResolverShape, SessionCarrier, Source, Tier) have no standing shape test, the proof for them is the one-off probe (diff empty, re-run here). AR-07-04: the World-table guard is a text scan (no regex literals or nested templates, map may drift from 07-WORLD-TABLE.md by design). AR-07-05: IN-03 deleted two redundant type claims, so a widening of the helper's own `Capture` alias is caught only indirectly"
    why_human: "Each is a bounded loss of a standing check, recorded by the security auditor 'for the orchestrator to confirm'. None breaks a roadmap criterion (criterion 3 asks for the name diff to be empty, which is pinned: 18 runtime names exactly, 12 type names by text check). Accepting residual risk is the user's decision."
  - test: "Bookkeeping before merge"
    expected: "(a) `07-SECURITY.md` still says T-07-23 is open and the sign-off says 'not merge-ready until T-07-23 is fixed'; the fix landed in 3f5f9b8a and was re-verified here (forced `tsc -b` clean), so amend that row and the sign-off line. (b) ROADMAP Phase 7 checkbox and progress row ('In Progress'), REQUIREMENTS WORLD-01, WORLD-02, CRED-01 (`[ ]`, 'Pending') are not flipped yet; the orchestrator owns `requirements.mark-complete` and `phase.complete`. (c) Postgres legs are local only; CI confirmation stays open (no git remote), and the Postgres run was not repeated after the review-fix commits (they changed comments, the guard and test pins only)"
    why_human: "Record-keeping and the standing no-remote caveat; none is a code gap."
---

# Phase 7: World scaffold and Credentials split (optional) Verification Report

**Phase Goal:** The BDD Worlds that repeat the shared host tail use one scaffold (`captureEvents`, composing with `TestAuth.layer` without re-wrapping it), and `server/Credentials.ts` is split into files with its public namespace frozen. Droppable.
**Verified:** 2026-11-15
**Status:** human_needed. No truth failed and no gap exists. Five judgement items and the bookkeeping remain for a human; none is a defect in the code. Verified at HEAD `3f5f9b8a` (includes review fixes WR-01..WR-03, IN-01..IN-03 and the T-07-23 fix), phase base `ee8b80a1`.
**Re-verification:** No, initial verification
**Method note:** the phase base and HEAD were compared with plain git only. Every check below was re-run in this verification, not read from a SUMMARY, unless the table says "recorded".

## Goal Achievement

The goal is achieved as the ROADMAP now words it. The 13 changed non-planning paths are exactly the scaffold, its type pin, the guard, the three adopter Worlds, the facade, five internal modules and the surface pin. `packages/test`, the five hand-wired Worlds, `OrganizationWorld`, all Credentials consumers, ADR-EA-042, `spec/`, `.changeset/`, `docs/`, `examples/` and `knip.json` have an empty diff (`git diff --name-only ee8b80a1 HEAD -- <paths>` printed nothing).

### Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A table classifies every World as scaffolded or exempt; a scaffold in `features/step-definitions/shared/` composing with `TestAuth.layer` (not re-wrapping it) supplies the one repeated tail piece, the `AuthEvents` capture layer, to the Worlds that repeat it (Admin, Password, Domain); `pnpm test:bdd` passes with the same scenario count | VERIFIED (wording is a human item 1) | `07-WORLD-TABLE.md` has 31 rows (3 scaffolded, 5 hand-wired, 23 no-tail); `ls features/step-definitions/*World.ts` gives 31, equal to the guard's `WORLDS` map (3 + 5 + 23 counted). `features/step-definitions/shared/EventCapture.ts` exports one overloaded function `captureEvents` returning `Layer<never, never, AuthEvents>`; it imports only `@awthaq/core` `AuthEvents` and `effect` modules, never `Auth.make`, `TestAuth` or a host. The three adopters import it and the diff shows the inline `Layer.effectDiscard` subscriber (Admin 22 lines, Domain and Password 14 each) and the `Stream` import deleted, the same position kept (`taps:` in Admin, last element of `services` in Password and Domain). Independent census: grep for `authEvents.stream/subscribe/on`, `forkScoped` over `features/step-definitions/*World.ts` finds only the scaffold, `OrganizationWorld.ts:121-128` (subscribe form, see item 3) and `EventsWorld.ts` (the events feature's own probes, not a tail); no other World repeats the capture. Re-run: `pnpm test:bdd` on SQLite with `AWTHAQ_POSTGRES_URL` unset: 40 files, 1581 passed, 44 skipped (baseline 39 / 1580 / 44; the +1 file and +1 test is the guard, the Gherkin scenario count and the 44 skipped are unchanged). The guard case reads files, strips comments, and goes red for an unclassified or vanished World, a hand-wired World without the header, an inline `.stream/.subscribe/.on/.onBatch` in a scaffolded World, a missing `captureEvents(` call and an import mismatch (07-REVIEW-FIX WR-02 lists seven recorded mutations, 07-SECURITY re-ran five). |
| 2 | The five hand-wired exempt Worlds are untouched, no second host composer exists, `LeakGuard` accounting is unchanged, and omitting a required service from a scaffolded World (measured on DomainWorld: dropping `NoBreachHttpClient` fails at `TestAuth.serve`) is still a compile error | VERIFIED | Empty diff for `AuthenticationWorld`, `ContractStratumWorld`, `CsrfWorld`, `QadiBridgeWorld`, `TenancyWorld`, `OrganizationWorld` and all of `packages/test` (includes `LeakGuard.ts`); `features/vitest.config.ts` not in the diff. The scaffold names no `AuthHost`, `makeLayer` or `Auth.make` (grep exit 1). Leak accounting: 40 `[leak-guard]` lines in the SQLite run end `apps=0 sqlClients=0` (recorded; sorted lines equal `07-LEAK-GUARD-BEFORE.txt` plus the guard's line). **Missing-service gate re-proved here, not read:** `npx tsc -b tsconfig.json --force` exits 0 with no output; `EventCapture.types.ts` carries `@ts-expect-error` plus `@effect-diagnostics-next-line missingLayerContext:off` on `TestAuth.serve(withoutBreachClient)`. I copied the file to a scratch probe in `features/step-definitions/shared/`, removed the `@ts-expect-error` line and ran the features project: `TS2379 ... Type 'HttpClient' is not assignable to type 'never'` at the `serve` argument (probe deleted, `git status features` clean afterwards). So the directive is consumed by a real missing-requirement error and is not a dead pin. The honest limit, stated in the file header and in D-03's correction: dropping a plugin from the `Auth.make` tuple is not a compile error and never was; the criterion is the narrower, measured claim. |
| 3 | `packages/server/src/Credentials.ts` is split into files under `server/src/internal/`; every `Credentials.*` name is still on the public namespace (export-name diff empty), ADR-EA-042 untouched, and `api-key`, `jwt`, `qadi`, `web` and `test` compile without edits | VERIFIED | `Credentials.ts` is a 52-line facade of named `export { } from` / `export type { } from` lists (no `export *`, no declaration); the five modules `PrincipalResolver`, `CredentialResolvers`, `Presented`, `Resolution`, `Scopes` are under `packages/server/src/internal/`. **Names:** base `Credentials.ts` at `ee8b80a1` has 18 value and 12 type exports (counted from `git show`); the facade lists the same 30. The probe `surface-probe-07.cjs` re-run here on the facade (TS 5.9.3 checker, `packages/server/tsconfig.src.json`): 81 lines, `diff` against `07-CRED-SURFACE-BEFORE.txt` empty; BEFORE equals the committed AFTER. **Verbatim move:** sorted line multiset of the base file against the five modules (my own check): the only base lines missing are the `const resolveClaimed` line and one merged `@awthaq/core` import line; the only added lines are imports, comments and the `export` keyword on `resolveClaimed` (internal to `internal/`, imported only by `Scopes.ts`, not reachable from `exports` which has the single key `.`). The three memo `WeakMap`s and `once` stay with `make` in `Resolution.ts`. **Standing pin:** `CredentialsSurface.test.ts` (18 runtime names exactly, 12 type names and "nothing else exports" by facade text, `Rotation`, `Scope`, `Resolved` by `Equal`); with `Credentials.test.ts` and `CredentialResolvers.test.ts`: 3 files, 97 passed (re-run). No file under `packages/{api-key,jwt,qadi,web,test,next}` and no test file other than the added pin changed; `tsc -b --force` exit 0 and `tsc -p tsconfig.test.json` exit 0 (only the two pre-existing TS377149 warnings in `TestingHarnessSteps.ts:851,853`). `spec/decisions/042-*.md`: empty diff; no changeset (the importable surface is byte-identical, same decision as the Phase 2 TestAuth split). |

**Score:** 3/3 truths verified. 0 behavior-unverified: the behaviour-dependent claims (event timing of the capture, memo and single-flight of the engine, rotation hand-off, missing-service error) each have a passing behavioural test or compiler check run in this verification (bdd 1581 passed, Credentials suites 97 passed, forced `tsc -b`, and the removed-directive probe).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| WORLD-01 | 07-04, 07-05, 07-06 | All Worlds classified; a scaffold in `shared/` composing with `TestAuth.layer` (without re-wrapping) for the tail that truly repeats | SATISFIED as aligned (human item 1) | Truth 1 |
| WORLD-02 | 07-04, 07-05, 07-07 | Five hand-wired Worlds not migrated; LeakGuard and the missing-service compile gate kept; no second host composer | SATISFIED | Truth 2 |
| CRED-01 | 07-01, 07-02, 07-03 | Credentials split under `internal/`, every name on the public namespace, ADR-EA-042 untouched | SATISFIED | Truth 3 |

No orphaned requirement: REQUIREMENTS.md maps only these three to Phase 7. The three rows are still `[ ]` / "Pending" (orchestrator bookkeeping, item 5).

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `AdminWorld.ts:105` | `shared/EventCapture.ts` | `taps: captureEvents(events, AuthEvents.is(worldEvents))` | WIRED | import at line 30; predicate overload keeps the narrower Ref type with no cast |
| `PasswordWorld.ts:172` | `shared/EventCapture.ts` | `captureEvents(events)` in `services` | WIRED | import at line 21 |
| `DomainWorld.ts:217` | `shared/EventCapture.ts` | `captureEvents(probes.events)` in `services` | WIRED | import at line 37 |
| `EventCapture.types.ts` | `TestAuth.layer`, `TestAuth.serve` | closed composition plus `@ts-expect-error` negative control | WIRED | checked by the `features` project of `tsc -b`; probe above shows the error is real |
| `world-table.steps.test.ts` | `features/step-definitions/*World.ts` | `readdirSync` plus source scan | WIRED | runs inside `pnpm test:bdd` (the 40th file) |
| `Credentials.ts` | `internal/*.ts` | 5 `export { } from` and 5 `export type { } from` clauses | WIRED | `Object.keys(Credentials)` equals the 18 pinned names (test green) |
| `internal/Scopes.ts` | `internal/CredentialResolvers.ts` | `resolveClaimed` | WIRED | the one internal-only export; `pnpm circular` exit 0 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `captureEvents` | the `Ref` of events | live `AuthEvents.stream` subscription, appended per event | Yes: adopter feature scenarios read the Ref back and assert event tags (admin impersonation, password, users-accounts features, all green) | FLOWING |
| `Credentials.*` | moved resolution engine | unchanged code, verbatim move | Yes: `Credentials.test.ts` runs 23 request shapes through 3 tiers | FLOWING |

### Behavioral Spot-Checks and Gates (re-run here)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Whole project compiles, nothing hidden by incremental state | `npx tsc -b tsconfig.json --force` | exit 0, empty output (T-07-23 is fixed: the red TS377034 is gone) | PASS |
| Test projects typecheck (surface shape pins) | `npx tsc -p tsconfig.test.json` | exit 0, 0 `error TS`, 2 pre-existing TS377149 warnings | PASS |
| Credentials surface pin and engine suites | `npx vitest run packages/server/test/CredentialsSurface.test.ts packages/server/test/Credentials.test.ts packages/server/test/CredentialResolvers.test.ts` | 3 files, 97 passed | PASS |
| Export surface unchanged | `TS_API_PATH=... node surface-probe-07.cjs packages/server/src/Credentials.ts packages/server/tsconfig.src.json` vs `07-CRED-SURFACE-BEFORE.txt` | 81 lines, diff empty | PASS |
| BDD on SQLite, same scenario count | `pnpm test:bdd` (Postgres URL unset) | exit 0, 40 files, 1581 passed, 44 skipped | PASS |
| No cycle | `pnpm circular` | exit 0 | PASS |
| Spec traceability | `pnpm spec:verify:strict` | PASS 32, FAIL 0, SKIP 0 | PASS |
| Postgres legs | recorded in `07-BASELINE.md` "Postgres at the close": bdd 40 / 1581 / 44, unit 435 files green on run 3 (known intermittent 3 fired twice, handled by the re-run rule); security audit re-ran the five adopter and guard files on Postgres (147 passed) | not repeated in this verification | recorded; CI confirmation open |

### Probe Execution

No `probe-*.sh` is declared by the plans. The Credentials export probe (a scratch checker script, not in the repo) was run and is listed above. SKIPPED otherwise.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| all 13 changed non-planning files | - | `TBD`, `FIXME`, `XXX`, `TODO`, `HACK` | none found (grep exit 1) | clean |
| `features/features/_guard/world-table.steps.test.ts` | 51-52 | `shortcut:` comment (comment stripper does not know regex literals or nested templates) | Info | named limit with a self-check; AR-07-04 |
| `packages/server/test/CredentialsSurface.test.ts` | 94-95 | `shortcut:` comment (reads the facade as text) | Info | named limit, AR-07-03 |

### Judgement items, assessed

1. **WORLD-01 read as "composes with, not wraps".** The code satisfies the aligned text exactly and the evidence for the change is real: `lazyApp` and `TestClock` are single `TestAuth` calls or options, and the one repeated piece is the `AuthEvents` capture layer in three Worlds, confirmed by my own grep. A wrapper over `TestAuth.layer` would have bought nothing and risked the missing-service error. The residual issue is process: three documents were rewritten to the result after research. I judge it honest (the ROADMAP says so, the table has a section "The honest record", CONTEXT D-09 states the reading) and recommend acceptance, but it is the user's call. Not a gap.
2. **Net size.** Not +1 at HEAD: 50 removed, 7 added in the Worlds, 48 in the helper, net +5 lines. Counting code only (helper 26 non-comment, non-blank lines, plus 7 added, against 50 removed) it is net negative; the comments carry the difference. It passes the deletion test, which is the criterion D-05 set. Keeping it for locality of the race fix is defensible; dropping it is also defensible. Item 2.
3. **IN-02 and OrganizationWorld.** The reviewer's "use `subscribe`, it is race-free by construction" was tested and was wrong in practice (5 Admin scenarios failed with a plain fork), which is the evidence for keeping `stream` + `startImmediately`. The helper comment was corrected honestly (the difference is the consumer's first run, not registration). What remains open is exactly what the record says: OrganizationWorld's tolerance was not measured and it is labelled `no-tail` while it holds a same-shaped capture. Acceptable for an optional phase; cheap to settle later. Item 3.
4. **AR-07-03, AR-07-04, AR-07-05.** Each is a real but bounded loss and each is disclosed in the file that carries it. AR-07-03 is the most substantive: nine exported types have no standing shape test, though the roadmap criterion (names) is pinned and the shapes were proven equal once by the probe, which I re-ran. I recommend accepting all three. Item 4.
5. **Stale records.** `07-SECURITY.md` still lists T-07-23 open (fixed in `3f5f9b8a`, confirmed here); `07-BASELINE.md` amendments already record the fix. Item 5.

### Gaps Summary

None. Every ROADMAP criterion is verified in code with evidence re-run in this pass, and the one defect the security audit found (T-07-23, a red `tsc -b`) is fixed at HEAD and confirmed by a forced build. The status is `human_needed` only because the five items above are decisions or record-keeping a person owns; none requires further code.

---

_Verified: 2026-11-15_
_Verifier: Claude (gsd-verifier)_
