# Phase 7: World scaffold and Credentials split (optional) - Research

**Researched:** 2026-11-15
**HEAD at research:** `d4556566f93f5cae1918324dd4d961e03cac74b2` (branch `architecture/deepening-batch-3`; `git diff --name-only 3be32564 HEAD -- packages features` lists 26 files, all Phase 6 work; the working tree has only `.planning/state.json` modified and untracked `.claude/`)
**Domain:** BDD World composition in `features/step-definitions/` (candidate C3) and a pure file split of `packages/server/src/Credentials.ts` (candidate C8)
**Confidence:** HIGH on the World census, the Credentials anatomy and the import graph (every count below was produced by a command or a file read this session); MEDIUM on the scaffold's line savings and its type-level behaviour (no prototype was compiled; Wave 0 must probe it); the baseline numbers are Phase 6 close numbers and must be re-recorded at the Phase 7 planning HEAD

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01 (scaffold home):** the scaffold lives in `features/step-definitions/shared/` only. No change to `packages/test` (`TestAuth` itself stays as Phase 2 left it) and no second host composer anywhere.
- **D-02 (exempt Worlds):** the five hand-wired exempt Worlds are not migrated and not edited (ROADMAP criterion 2). The classification table names them and states why each is exempt. The table is a committed artifact (`07-WORLD-TABLE.md`) and, if cheap and non-brittle, pinned by a test that fails when a new World is added without a classification.
- **D-03 (gates kept):** `LeakGuard` accounting is unchanged; omitting a plugin from a scaffolded World is still a compile error (the existing compile-time gate files keep passing; a type-level pin proves the scaffold does not widen the plugin requirement).
- **D-04 (behaviour):** `pnpm test:bdd` keeps the same scenario count and results (baseline: 1580 passed / 44 skipped, 39 files, from Phase 6 close). Scaffolding must be behaviour-preserving: same layer order, same clock, same capture semantics.
- **D-05 (deletion test):** a World is `scaffolded` only if the scaffold removes real repeated tail code from it (deletion test: the repeated lines vanish, not move). A World that repeats only part of the tail, or varies the tail in a way the scaffold would need an option for, is `exempt` unless the option is a single honest parameter. Cleanest end state over maximal adoption; if fewer than about 4 Worlds truly repeat the tail, the honest outcome is a smaller scaffold plus a table, and that is recorded, not padded.
- **D-06 (Credentials split):** split by concern into `packages/server/src/internal/*.ts`; `Credentials.ts` stays as the public module re-exposing the same namespace members. The export-name diff (before/after, including types) must be empty, `.d.ts` shape of the public namespace unchanged, and `api-key`, `jwt`, `qadi`, `web` and `test` compile without edits. No behaviour change, no renames, no new exports. `madge`/`pnpm circular` (type-only cycles count) must stay clean; knip must not gain rows.
- **D-07 (ADR-EA-042):** untouched. If the split seems to need an ADR edit, stop and record why rather than editing.
- **D-08 (gates):** same gate set and comparison rule as Phase 6 (`06-BASELINE.md` shape): tsc -b, circular, error-tags, transactions, contract-tests, lint, format, readmes, workspace, spec:verify:strict, knip filtered, unit and bdd on SQLite and Postgres (container `awthaq-p3-pg`, recreate first, explicit `AWTHAQ_POSTGRES_URL`). Spec/changeset rows only if a package-visible or spec-visible change exists; a changeset is needed only if `@awthaq/server` output changes (a pure internal split should not: record the decision).

### Claude's Discretion

All other choices are at Claude's discretion under the standing rule: the cleanest end state, complexity accepted (CONTEXT header: "no discuss questions: roadmap research was 'skip' and every grey area is locked by REQUIREMENTS.md and the user's standing rule: cleanest end state, complexity accepted").

### Deferred Ideas (OUT OF SCOPE)

- Migrating the exempt Worlds, or building a general World factory.
- Any `TestAuth` redesign (Phase 2 is closed).
- Splitting other large modules.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| WORLD-01 | All Worlds are classified; a scaffold in `features/step-definitions/shared/` wraps `TestAuth.layer` for the shared tail (`lazyApp`, `TestClock`, capture layers) in the Worlds that repeat it | Q1 (31-World census; the "shared tail" repeats in far fewer Worlds than the roadmap assumed), Q2 (scaffold interface and the D-05 go/no-go; the literal word "wraps" is not recommended and needs an orchestrator decision) |
| WORLD-02 | The five hand-wired exempt Worlds are not migrated; `LeakGuard` accounting and the compile-error-on-missing-plugin gate are kept; no second host composer is created | Q1 (the five, their source, the partial contradiction), Q2 (type-level evidence, LeakGuard accounting), Q4 (gates) |
| CRED-01 | `server/src/Credentials.ts` is split into files under `server/src/internal/` with every `Credentials.*` name still on the public namespace and ADR-EA-042 untouched | Q3 (30 exported names, 5 seams, import graph, proof commands, risks) |
</phase_requirements>

## Project Constraints (from CLAUDE.md / AGENTS.md)

No `CLAUDE.md` exists in the worktree. `/Users/mohammadalmechkor/Projects/Perso/awthaq-arch/AGENTS.md` binds: domain docs are `spec/overview.md`, `spec/decisions/`, `spec/behaviors/`, `spec/traceability.md`; plugin conventions `docs/plugin-authoring.md`. Carried-over repo rules that bind this phase:

- Library source forbids type assertions (`.oxlintrc.json:33-37`, "`as const` stays allowed", [CITED: 06-RESEARCH.md Project Constraints]). `Credentials.ts` already contains `as const` returns (lines 504, 546-552) that must move verbatim.
- `verbatimModuleSyntax: true` and `allowImportingTsExtensions: true` ([VERIFIED: `tsconfig.base.json:23-25`], quoted: `"allowImportingTsExtensions": true,` / `"verbatimModuleSyntax": true,`). Every type-only re-export in the new `Credentials.ts` must be `export type { ... }`, and every internal import carries the `.ts` extension.
- `.planning/README.md` shared conventions (via 06-RESEARCH): no return-type annotations on new Effect/Layer consts; replace-don't-layer tests; a changeset only for a package-visible change.
- Executors do not run `requirements.mark-complete`; roadmap/requirements checkboxes belong to the orchestrator.

## Summary

**C8 (Credentials) is a clean, low-risk split.** `Credentials.ts` is 678 lines [VERIFIED: `wc -l`], exposed as one namespace by a single line, `export * as Credentials from "./Credentials.ts";` (`packages/server/src/index.ts:20`). It exports exactly 30 names (14 value, 12 type, 4 value+type classes) [VERIFIED: the Phase 2 checker probe, run this session on `packages/server/src/Credentials.ts`, output `sha256 efbf9b94e28774245a5630cdc2f9b1f3a17ccfe5b810211176af9ac31a7a9a1d`, 81 lines, 0 `import(` text, identical on two consecutive runs]. It has five natural seams that form an acyclic graph (three leaves, one engine, one adapter pair), and the only module-level mutable state (three `WeakMap`s and `once`) is used by exactly one function (`make`), so it moves as one unit. The only things that can go wrong are mechanical: `export *` leaking private helpers, a missing `export type` under `verbatimModuleSyntax`, a facade that internal modules import back (a type-level cycle that `pnpm circular` counts), and knip flagging an internal export that nothing imports. The spec cites no source path of `Credentials.ts` [VERIFIED: grep over `spec docs features/traceability.md .changeset` for `Credentials.ts` returned no `server/src/Credentials` line], so no spec edit is needed, and a pure internal split carries no changeset (Phase 2 precedent).

**C3 (World scaffold) mostly does not survive the deletion test, and the roadmap's premise is wrong.** The roadmap says the Worlds repeat a "shared tail (`lazyApp`, `TestClock`, capture layers)". Measured over all 31 `*World.ts` files, that tail does not repeat as code:

- `lazyApp` is one call to the shared `TestAuth.lazyApp` primitive in each of 11 Worlds (11 call sites, no repeated body): there is nothing to delete.
- `TestClock` is a one-option setting already provided by `TestAuth` (`serve({ testClock: "now" })` in `SessionWorld.ts:189`; `lazyApp(..., { alignStepClock: true })` in `DeviceAuthorizationWorld.ts:136`, `MagicLinkWorld.ts:172`, `CliWorld.ts:380`). Exactly one World builds a clock layer by hand (`SamlWorld.ts:189-191`). The other TestClock hits in 15 Worlds are step-time `TestClock.adjust` calls and comments.
- Capture layers: exactly one piece repeats, the `AuthEvents` subscriber layer (`Layer.effectDiscard` over `authEvents.stream`, `Effect.forkScoped({ startImmediately: true })`): `AdminWorld.ts:89-107`, `PasswordWorld.ts:163-174`, `DomainWorld.ts:171-180` (three, same shape; differ only in the target `Ref` and, in Admin, a `Stream.filter(AuthEvents.is(worldEvents))`), plus `OrganizationWorld.ts:119-131` which uses `authEvents.subscribe` instead of `stream` plus `startImmediately` (a different registration semantic, so not a copy). The only log-capture layer in a lazyApp World (`SamlWorld.ts:181-188`) is that World's own, writing to its own `observations`.

So by the D-05 rule (about 4 Worlds) the honest outcome is **a smaller scaffold plus the table**: one `shared/` helper for the events-capture layer, adopted by 3 Worlds (Admin, Password, Domain), net saving about 13 lines before the pin test, kept for locality (the `startImmediately` race-fix comment currently lives in `AdminWorld.ts:94-99` and is copied by reference into two more files), not for size. A wrapper around `TestAuth.layer` is **not** recommended: it would restate the 8 type parameters of the `layer` overloads (`composition.ts:253-286`) and put the missing-plugin gate at the mercy of a widened signature (Q2). Two decisions belong to the orchestrator (see "Decisions for the orchestrator" in Open Questions): (1) accept a scaffold that supplies one tail piece and does not literally "wrap `TestAuth.layer`", or take the pure table-only no-go; (2) accept that "five hand-wired exempt" is the right header-exempt set but three of the five (`CsrfWorld`, `ContractStratumWorld`, `TenancyWorld`) still call `TestAuth.layer`/`serve` for part of their stacks, and that 23 further Worlds are exempt for a different reason (no repeated tail), so the table has three classes, not two.

**Primary recommendation:** plan (a) a Wave 0 baseline plus the committed `07-WORLD-TABLE.md` and a guard test; (b) the `captureEvents` helper adopted by Admin, Password, Domain, with a type-level pin; (c) the Credentials split in five internal modules behind a named-re-export facade, proven by the checker probe diff; (d) phase close with the gates. Keep C3 and C8 file-disjoint so they can run in parallel waves.

## Architectural Responsibility Map

This phase has no browser, SSR or CDN tier. Tiers are the repo's strata (`api < ports < sql < core < server < qadi < plugins < cli/test/features`).

| Capability | Primary tier | Secondary tier | Rationale |
|------------|-------------|----------------|-----------|
| Credential resolution policy (carriers, tiers, memo, rotation hand-off) | `@awthaq/server` `Credentials` (stratum 5, HTTP) | `qadi`, `web`, `api-key`, `jwt` (adapters and contributors) | ADR-EA-042 decision 1: "One module, `Credentials`, in `@awthaq/server`"; `web` and `qadi` already depend on `server` |
| Internal organisation of that module | `packages/server/src/internal/` | - | Precedent: `internal/SessionCookie.ts`, `SessionDto.ts`, `BrowserPage.ts`, imported by `Session.ts` and `SessionDelivery.ts` |
| The one test host | `@awthaq/test` `TestAuth.layer` (unchanged) | - | D-01, ADR-EA-044 decision 6; no second composer |
| World-level observation helper (events capture) | `features/step-definitions/shared/` | the 3 adopting Worlds | D-01; carries BDD conventions, depends only on `@awthaq/core` `AuthEvents` |
| The World classification record | `.planning/phases/07-.../07-WORLD-TABLE.md` plus a guard test in `features/features/_guard/` | - | D-02; precedent for a repo guard that lives beside the suite: `features/features/_guard/step-patterns.steps.test.ts` |

## Standard Stack

No new package and no version bump (REQUIREMENTS Out of Scope: "New dependencies or version bumps"). Everything is already installed.

### Core
| Library | Version | Purpose | Why standard |
|---------|---------|---------|--------------|
| `effect` | 4.1.2 | `Layer`, `Stream`, `Ref`, `Effect` used by the helper and the moved code | [CITED: 06-RESEARCH.md, `packages/sql/node_modules/effect/package.json` prints `4.1.2`] |
| `@awthaq/test` `TestAuth` | in tree | the one host (`layer`, `serve`, `lazyApp`, `openApps`) | unchanged (D-01) |
| `@effect-cucumber/vitest` | `^0.10.1` | the BDD runner | [VERIFIED: `features/package.json`, quoted `"@effect-cucumber/vitest": "^0.10.1"`] |
| TypeScript checker API 5.9.3 | `node_modules/.pnpm/typescript@5.9.3` | the export-surface probe (a measuring instrument only, never added to a `package.json`) | Phase 2 method; `typescript` in the repo is 7.0.2 (tsgo, no compiler API) [VERIFIED: `ls node_modules/.pnpm | grep typescript@` printed `5.6.1-rc`, `5.9.3`, `7.0.2`; `npx tsc -v` = `Version 7.0.2+effect-tsgo.0.67.4`] |

### Alternatives Considered
| Instead of | Could use | Tradeoff |
|------------|-----------|----------|
| A helper that returns the capture layer | A wrapper `hostFor(built, options, capture)` around `TestAuth.layer` | The wrapper must restate `CommonOptions<S, SE, SR, D, DR, T>` and both `MemoryMode`/`SqlMode` overloads (`composition.ts:253-286`), duplicating the shape the gate lives in (Pitfall 1). Not recommended |
| Named re-exports in `Credentials.ts` | `export * from "./internal/..."` | `export *` would publish the private helpers (`once`, `findClaim`, `resolveClaimed`, the memo tables) and change the namespace; rejected |
| A byte hash of `Credentials.d.ts` (the Phase 6 `06-SHAPE-DTS.sha256` method) | The checker-based surface probe (Phase 2) | The Phase 6 hashes were taken on files that did not change. `Credentials.d.ts` will change textually (it becomes re-export lines), so a byte hash cannot be the proof here. Use the probe, whose printed types are scope-free |

**Installation:** none. **Version verification:** nothing is installed; `effect` 4.1.2 is carried over from the Phase 6 read of the installed package.

## Package Legitimacy Audit

None: this phase installs no external package. No `gsd-tools query package-legitimacy check` run was needed.

**Packages removed due to [SLOP] verdict:** none. **Packages flagged [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram

```
C3 (features only)                                          C8 (packages/server only)

 feature file -> *.steps.test.ts -> *Steps.ts -> World       importers (31 files, 11 areas, Q3)
                                       |                       web/qadi/api-key/jwt/test/features
   WorldLive = Layer.effect(World, ...)                        |  Credentials.<member>
        |                                                      v
        | TestAuth.lazyApp(initial, build, {name, alignStepClock?})      index.ts:20  export * as Credentials
        v                                                      |
   build(options) = TestAuth.serve(layer, {baseUrl, testClock?})         v
        |        (openAppCount++ ... release: --)            Credentials.ts  (facade: named re-exports only)
        v                                                      |       |        |         |          |
   layer = TestAuth.layer(Auth.make([...]), {services, decorate, taps})  v       v        v          v
        |                         |                    internal/ Principal  Credential  Presented  Resolution  Scopes
        |   [today, 3 Worlds]     +-- taps/services <-- Resolver.ts Resolvers.ts .ts     .ts (make,   .ts (httpScope,
        |   inline AuthEvents subscriber                    (leaf)   (leaf)     (leaf)    memo,        collecting,
        |   [proposed] shared/EventCapture.ts                                              Scope)       rotationDelivery)
        |        captureEvents(ref, keep?) : Layer<never,never,AuthEvents>              ^ imports the 3 leaves   ^ imports Resolution
        v                                                                                 (types) and PrincipalResolver  (types) + Resolvers
   scenario step -> app.handler / app.run -> LeakGuard reads TestAuth.openApps() / TestSql.openClients() after each file
```

The scaffold sits beside `TestAuth.layer` (it returns a layer that goes into `taps` or `services`), not around it. The Credentials split is a DAG: `PrincipalResolver`, `CredentialResolvers` and `Presented` are leaves; `Resolution` imports all three; `Scopes` imports `Resolution` (types) and `CredentialResolvers`.

### Recommended Project Structure

```
features/step-definitions/shared/EventCapture.ts          # new: captureEvents (only if the orchestrator takes the small scaffold)
features/step-definitions/shared/EventCapture.types.ts    # new: type-level pin (typechecked, never run)
features/features/_guard/world-table.steps.test.ts        # new: classification guard (the _guard/ precedent)
.planning/phases/07-.../07-WORLD-TABLE.md                 # the committed table (Q1 below is its source)
packages/server/src/Credentials.ts                        # facade: header + named re-exports (30 names)
packages/server/src/internal/PrincipalResolver.ts         # 5 names + 1 private (userPrincipalOf)
packages/server/src/internal/CredentialResolvers.ts       # 8 public names + resolveClaimed (internal export), findClaim private
packages/server/src/internal/Presented.ts                 # Carrier, SessionCarrier, Presented, Source, presented, fromRequest, Tier, tier, 3 tiers
packages/server/src/internal/Resolution.ts                # Rotation, Scope, Resolved, principalFields, make (+ memo tables, once, outages private)
packages/server/src/internal/Scopes.ts                    # httpScope, collecting (+ rotationDelivery private)
```

File names follow the existing `internal/` precedent (PascalCase module names). The grouping above is a recommendation; the planner may merge `Scopes` into `Resolution` (their sum is about 330 lines) but must not split `make` from the three `WeakMap`s (Pitfall 4).

### Pattern 1: A helper that returns a layer, composed at the World's own `TestAuth.layer` call
**What:** the scaffold produces the capture layer only; each World keeps its own `Auth.make([...])` and `TestAuth.layer(built, {...})` so the plugin tuple, `Requires<...>` and the missing-plugin errors stay exactly where they are.
**When to use:** the 3 Worlds whose inline `eventsLayer` is the same shape.
**Example (proposed, not compiled):**
```typescript
// Source: today's inline copies, AdminWorld.ts:89-107, PasswordWorld.ts:163-174, DomainWorld.ts:171-180
// features/step-definitions/shared/EventCapture.ts
import { AuthEvents } from "@awthaq/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

/**
 * One `AuthEvents` subscriber a World reads back, registered before anything can publish: the stream is a live
 * broadcast, so a publish that beats the subscription is gone for good, hence `startImmediately` (AdminWorld's
 * reproduced race, packages/core/test/AuthEvents.test.ts has the same fix).
 */
export const captureEvents = <E extends AuthEvents.PublishedAny = AuthEvents.PublishedAny>(
  into: Ref.Ref<ReadonlyArray<E>>,
  keep?: (event: AuthEvents.PublishedAny) => event is E,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const authEvents = yield* AuthEvents.AuthEvents;
      const events = keep === undefined ? authEvents.stream : Stream.filter(authEvents.stream, keep);
      yield* events.pipe(
        Stream.runForEach((event) => Ref.update(into, (existing) => [...existing, event])),
        Effect.forkScoped({ startImmediately: true }),
      );
    }),
  );
```
The conditional stream needs care under `exactOptionalPropertyTypes` and no-`as`: the `Stream.filter(authEvents.stream, keep)` branch returns `Stream<E>` and the other `Stream<PublishedAny>`, so the two branches do not unify when `E` is narrower. The planner should make `keep` required-or-identity via two exported constants (`captureEvents(ref)` and `captureEvents(ref, AuthEvents.is(worldEvents))`) or overload it; Wave 0 compiles the chosen shape before any World is edited. [ASSUMED: the generic shape above compiles as written; `AuthEvents.is` returns `(event: PublishedAny): event is Handled<S>` [VERIFIED: `packages/core/src/AuthEvents.ts:409-418`, quoted `return (event: PublishedAny): event is Handled<S> => {`], which is what `keep` needs.]

### Anti-Patterns to Avoid
- **A wrapper around `TestAuth.layer` that forwards `options`:** it copies the overload set and the 8 type parameters, so its inferred `Requires` can drift from `TestAuth.layer`'s (PITFALLS Pitfall 16: "a widened generic composer erases" the exact types the compile-time gates rely on).
- **A World factory (`makeWorld({...})`):** explicitly deferred (CONTEXT Deferred: "building a general World factory").
- **Moving the memo `WeakMap`s into a different module than `make`:** the single-flight guarantee (PCS-006/TS-003) is per module instance; two modules that each hold a table silently break it (Pitfall 4).
- **`export *` in the Credentials facade** (Pitfall 3).

## Don't Hand-Roll

| Problem | Don't build | Use instead | Why |
|---------|-------------|-------------|-----|
| Starting a World's app clock | a hand-rolled `TestClock.layer()` + `setTime` layer | `TestAuth.serve(layer, { testClock: true \| "now" })` or `TestAuth.lazyApp(..., { alignStepClock: true })` | Already options of the one host (`appHarness.ts:134-148`, `:360-364`); `SamlWorld.ts:189-191` is the lone hand-rolled copy and is not touched |
| The lazily built app cell | a second cell type | `TestAuth.lazyApp` | `features/STYLE.md:235`: "A World that serves an `Auth.make` composition holds exactly one `TestAuth.lazyApp` cell, named after the World" |
| A host composer for Worlds | `hostFor(...)` | `TestAuth.layer` | D-01, ADR-EA-044 decision 6 |
| The export-surface diff for `Credentials` | a hand-written name list | the Phase 2 checker probe (`getExportsOfModule`) | It prints kinds and scope-free types, so it also catches a changed type, not only a changed name |

**Key insight:** the "shared tail" the roadmap describes was mostly absorbed into `TestAuth` options in Phases 2 and earlier (plan 08, plan 34); what is left to deduplicate across Worlds is one 10-line subscriber layer.

## Runtime State Inventory

Not a rename/refactor of stored strings: omitted per the template. (Checked for the Credentials split: the three `WeakMap`s are in-process, keyed by request identity, garbage-collected with the request; no persisted state, no registered OS state, no env var and no secret name changes. Build artifacts: `packages/server/lib/` is git-ignored [VERIFIED: `git check-ignore packages/server/lib` printed the path] and is regenerated by `tsc -b`; `lib/internal/` already exists with 3 modules.)

## Q1: The World census (the content of `07-WORLD-TABLE.md`)

Population: the 31 `features/step-definitions/*World.ts` files [VERIFIED: `ls features/step-definitions/*World.ts | wc -l` printed 31]. No inline World exists: `class World extends` appears only in `*World.ts` files (30 of them; `PersistenceStratumWorld.ts` has no class and reuses `FoundationsWorld`'s) [VERIFIED: `grep -rl "class World extends" features --include='*.ts'` printed only `features/step-definitions/*World.ts` and their `lib/*.d.ts`]. Three shared host/support modules exist outside `*World.ts`: `CrossCuttingApp.ts` (250 lines, an existing shared composer, see below), `DomainSupport.ts`, `TestingHarnessComposeFixtures.ts`.

### The five hand-wired exempt Worlds and where the list comes from

Source of the list [VERIFIED: grep for `Hand-wired on purpose` printed one line in each of five files]: the header comment of each file: `AuthenticationWorld.ts:1`, `ContractStratumWorld.ts:3`, `CsrfWorld.ts:1`, `QadiBridgeWorld.ts:1`, `TenancyWorld.ts:1`, each ending "(plan 08 exemption)". The roadmap/requirement text (`ROADMAP.md:190`, `REQUIREMENTS.md:61`) takes the number from `.planning/research/ARCHITECTURE.md:133` and `:330`, `FEATURES.md:115`, `SUMMARY.md:22/153`, `PITFALLS.md:209`; the rule they cite is plan 08 (`.planning/08-test-composition/PLAN.md:803`, as quoted by `FEATURES.md:126`: "Hand-wired exemptions stay hand-wired where the wiring is the thing under test"). No Phase 2 artifact contains the list (`grep -n "hand-wired\|exempt" .planning/phases/02-split-testauth` has no World list). The count is exactly five; it is not contradicted. **What the inventory does contradict is the word "hand-wired" for three of them**, which still call the shared host for part of their stacks:

| World | Header says | Still calls `TestAuth` | Lines |
|-------|-------------|------------------------|-------|
| `CsrfWorld.ts` | "the shipped CSRF middleware in front of small plugins, with its configuration varied per scenario" | `TestAuth.layer` ("composed through `Auth.make` and served by `@awthaq/test`'s `TestAuth.layer`", header lines 4-6) | 172, 174, 175 |
| `ContractStratumWorld.ts` | `authProbeApp` re-declares the authentication record; "The other two apps are `TestAuth.serve` compositions" | `TestAuth.layer`/`serve` for `passwordApp` and `coreOnlyApp` | 169, 170, 181 |
| `TenancyWorld.ts` | identity stack and connection stack hand-wired; "the organization and OAuth stacks run on `TestAuth.layer`"; "Every stack is built through `TestAuth.buildContext`" | `TestAuth.layer` | 199, 245, 339, 513, 549 |
| `AuthenticationWorld.ts` | probe groups re-declare the authentication record | none (0 hits for `TestAuth.layer`, `serve`, `buildContext`, `listen`) | - |
| `QadiBridgeWorld.ts` | "the fixture is not an `Auth.make` composition" (bespoke `HttpApi`, counting `SubjectResolver`) | none (0 hits); own `Logger.layer` at `:714`, `RequestContextLive` at `:773` | - |

All five stay untouched (D-02). The guard test pins them by content (their header line still reads `Hand-wired on purpose`) and by absence of the scaffold import.

### Existing shared host composer (a D-01 fact the planner must know)

`features/step-definitions/CrossCuttingApp.ts` is already a features-side host for three Worlds (`HooksWorld.ts:22`, `EventsWorld.ts:21`, `RateLimitingWorld.ts:31` import `makeHost`/`composition`). It calls `TestAuth.layer(composition, ...)` (`:~100-121`) but builds with `Layer.buildWithScope` (`:~151`), **not** `TestAuth.serve`, so those Worlds never touch `TestAuth.openApps()` and `LeakGuard` does not count them. It is not part of this phase, is not migrated, and its existence is why the scaffold must not be a "host composer": a second one is exactly what D-01 forbids, and a third World family would then compose differently again.

### Census table (all 31 Worlds)

Class codes: **S** = scaffolded (the scaffold removes repeated tail code); **H** = exempt, hand-wired on purpose (the five); **N** = exempt, no repeated tail (the deletion test fails: nothing repeated to delete). Columns: composition = how the World reaches `TestAuth` (lines are in the file named in the row). `lazyApp` = the `TestAuth.lazyApp(...)` call. clock = how the World sets a clock in its host. capture = a layer that records events or logs.

| # | File (lines) | Composition | `lazyApp` | clock (in the host) | capture (exact range) | Class and deletion-test reason |
|--:|--------------|-------------|-----------|---------------------|-----------------------|--------------------------------|
| 1 | `AdminWorld.ts` (305) | `TestAuth.layer` `:116-125`; `TestAuth.serve` `:147-149` | `:157-159` | none | `AuthEvents` subscriber **`:89-107`** (`stream`, `Stream.filter(AuthEvents.is(worldEvents))`, `startImmediately`), used as `taps: eventsLayer` `:124` | **S**: the 19-line subscriber vanishes (becomes one `captureEvents(events, AuthEvents.is(worldEvents))` call) |
| 2 | `AuthenticationWorld.ts` (617) | hand-wired, no `TestAuth` call | none | none | none | **H**: header `:1`; `Authentication`'s own composition is under test |
| 3 | `ClientEffectWorld.ts` (121) | none (stub `HttpClient`, no server) | none | none | none | **N**: no host at all |
| 4 | `CliWorld.ts` (525) | `TestAuth.listen(TestAuth.layer(...))` `:265-269`, `:283-289` (a socket, not `serve`) | `:375-382` | `alignStepClock: true` `:380` | none (console capture is the CLI's, not an event layer) | **N**: one `lazyApp` call + one existing option; `listen` differs from `serve` |
| 5 | `ContractStratumWorld.ts` (334) | `authProbeApp` hand-wired; `passwordApp`, `coreOnlyApp` via `TestAuth.layer`/`serve` `:169-170,:181` | none | none | none | **H**: header `:3` |
| 6 | `CsrfWorld.ts` (357) | `TestAuth.layer` `:172-175` under the shipped CSRF middleware | none | none | none | **H**: header `:1`; configuration is the variable under test |
| 7 | `DeviceAuthorizationWorld.ts` (239) | `TestAuth.layer` `:85`; `TestAuth.serve` `:102` | `:134-137` | `alignStepClock: true` `:136` | none | **N**: one `lazyApp` call + one existing option |
| 8 | `DomainWorld.ts` (330) | `TestAuth.layer({ records: "sql" })` `:221`; `TestAuth.serve` + `app.context()` `:293-294` | none (eager build in `WorldLive`) | none | `eventsLayer` **`:171-180`** (`stream`, `startImmediately`, target `probes.events`), used `:229` | **S**: the 10-line subscriber vanishes |
| 9 | `EventsWorld.ts` (290) | none directly; `makeHost` from `CrossCuttingApp.ts` `:21` | none | none | its own subscriber probes (the thing under test) | **N**: host is `CrossCuttingApp`; the subscribers are the scenarios |
| 10 | `FoundationsWorld.ts` (98) | none | none | none | none | **N**: scratch cell only |
| 11 | `HooksWorld.ts` (344) | `makeHost` `:22`; `TestAuth.layer(fixturePlugins)` `:165`; `runPluginContractTests` `:197` | none | none | none | **N** |
| 12 | `HttpErrorWorld.ts` (375) | `TestAuth.layer` x7 `:180-207`; `TestAuth.serve` `:154` in `makeApp` | none | none | none | **N**: no cell, clock or capture to remove |
| 13 | `JwtWorld.ts` (370) | `TestAuth.layer` `:33`; `TestAuth.serve` `:49-52` | `:90` | none | none | **N**: one `lazyApp` call |
| 14 | `MagicLinkWorld.ts` (280) | `TestAuth.layer` `:114`; `TestAuth.serve` `:142` | `:172` | `alignStepClock: true` `:172` | none | **N**: one `lazyApp` call + one existing option |
| 15 | `NextSsrWorld.ts` (143) | `TestAuth.layer` `:79`; `TestAuth.serve` `:89,:135` | none | none | none | **N** |
| 16 | `OAuthWorld.ts` (262) | `TestAuth.layer` `:116,:138` (no `serve`) | none | ambient `TestClock` (comment `:17`) | none | **N**: own layering, no tail |
| 17 | `OrganizationWorld.ts` (356) | `TestAuth.layer` `:78`; `TestAuth.serve` `:132` | `:185-188` | none | subscriber **`:119-131`** using `authEvents.subscribe` (no `startImmediately`) | **N** (variant): registers through `subscribe`, a different registration semantic; moving it to `stream` + `startImmediately` is a behaviour change (D-04). Adopt only if the orchestrator accepts a one-parameter `registration` option |
| 18 | `PasskeyWorld.ts` (434) | `TestAuth.layer` `:160`; `TestAuth.serve` `:206-208` | `:216-218` | none (the `TestClock` hits `:306-320` are comments) | none | **N**: one `lazyApp` call |
| 19 | `PasswordWorld.ts` (647) | `TestAuth.layer` `:203,:215,:218`; `serve` `:155-156` | `:251-253` | none | `eventsLayer` **`:163-174`** (`stream`, `startImmediately`, target `events`), used `:184` | **S**: the 12-line subscriber vanishes |
| 20 | `PersistenceStratumWorld.ts` (204) | `TestAuth.memoryFoundation` `:162` only | none | none | none | **N** |
| 21 | `QadiBridgeWorld.ts` (1040) | hand-wired, no `TestAuth` call | none | none | own `Logger.layer` `:714` | **H**: header `:1` |
| 22 | `RateLimitingWorld.ts` (517) | `makeHost` `:31`; `TestAuth.layer` `:94,:160` | none | `TestClock` drives windows in steps | none | **N** |
| 23 | `ReactWorld.ts` (157) | `TestAuth.layer` `:44`; `TestAuth.serve` `:46` | none | none | none | **N** |
| 24 | `SamlWorld.ts` (648) | `TestAuth.layer` `:195-211`; `TestAuth.serve` `:234` | `:342-355` | hand-rolled `ClockLive` **`:189-191`** | own `Logger.layer` `Capture` **`:181-188`** (writes `observations.logText`/`reasons`), `RequestContextLive` `:209` | **N**: the only World with all three pieces, but alone (1 of 31) and each is World-specific; extracting it would move lines, not delete repeated ones |
| 25 | `ScimWorld.ts` (317) | `TestAuth.layer` `:95`; `TestAuth.serve` `:142-145` | `:182` | none | none | **N**: one `lazyApp` call |
| 26 | `SessionWorld.ts` (521) | `TestAuth.layer` `:105`; `TestAuth.serve(..., { testClock: "now" })` `:189` | `:179-199` | `testClock: "now"` `:189` (existing option) | none | **N**: one `lazyApp` call + one existing option |
| 27 | `SmokeWorld.ts` (40) | none | none | none | none | **N**: tooling smoke World |
| 28 | `TenancyWorld.ts` (630) | `TestAuth.layer` `:199,:245,:339,:513,:549`; every stack via `buildContext` | none | `TestClock` `:1 hit` (step time) | none | **H**: header `:1-3` |
| 29 | `TestingHarnessWorld.ts` (347) | `TestAuth.layer` x11 (`:51,:84,:138,:152,...`) | none | none | none | **N**: the harness's own public surface is the subject |
| 30 | `TwoFactorWorld.ts` (540) | `TestAuth.layer` `:115`; `TestAuth.buildContext` `:258`, `:518` (no `serve`) | none | `TestClock.adjust` `:302` (steps) | none | **N** |
| 31 | `WebhooksWorld.ts` (518) | `TestAuth.layer` `:198`; `TestAuth.serve` `:267-269` | none | `TestClock.adjust` `:518` (steps) | none | **N** |

Counts [VERIFIED: per-file `grep -c` runs this session]: S = 3 (Admin, Domain, Password), H = 5 (Authentication, ContractStratum, Csrf, QadiBridge, Tenancy), N = 23. 11 Worlds hold a `lazyApp` cell (Admin, Cli, DeviceAuthorization, Jwt, MagicLink, Organization, Passkey, Password, Saml, Scim, Session); 24 Worlds call `TestAuth.layer`. These match `FEATURES.md:114` ("`lazyApp` cell in 11 Worlds, `TestClock` in 15") and differ from `ARCHITECTURE.md:133` ("12 hold a `TestAuth.lazyApp` cell"; that count is over all 55 TestAuth-importing step files, not Worlds).

**What repeats, measured.** Per tail piece, how many Worlds carry a copy that a helper could delete:

| Tail piece | Worlds | Copy? | Verdict |
|------------|-------:|-------|---------|
| `TestAuth.lazyApp(...)` call | 11 | one call each to a shared primitive; bodies differ (`buildApp` per World) | nothing to delete |
| `getApp` accessor (`const { app } = yield* World; return yield* app.get`) | 10 of the 11 (`JwtWorld.ts:102-105`, `ScimWorld.ts:196-199`, `OrganizationWorld.ts:221-224` identical; Admin `:174-177`, Passkey `:250-253`, Password `:288-`, Session `:220-`, MagicLink `:195-`, DeviceAuthorization `:162-` are `Effect.fn`-named variants; Saml `:377-` also sets `started`) | 4 lines, bound to each World's own `World` tag | a factory over the `World` tag turns 4 lines into 1: a move, and a World factory is deferred |
| clock | 5 (Session option, DeviceAuthorization/MagicLink/Cli option, Saml hand-rolled) | options already in `TestAuth`; 1 hand-rolled | nothing to delete except Saml's (alone) |
| events subscriber | 4 (Admin, Password, Domain verbatim; Organization `subscribe` variant) | **3 same-shape copies** | the one real repeat |
| log capture | 3 in different files (Saml `:181-188`, `CrossCuttingApp.ts:55-`, QadiBridge `:714`) | three different bodies | not a copy |

## Q2: The proposed scaffold and the D-05 go/no-go

### Go/no-go (D-05)

By the rule "about 4 Worlds": the tail the roadmap names repeats in **3 Worlds, and only for one of the three pieces** (events subscriber). **Verdict: GO for a smaller scaffold, NO-GO for a "tail scaffold" wrapping `TestAuth.layer`.** The honest record for `07-WORLD-TABLE.md`: scaffolded = Admin, Domain, Password; exempt-hand-wired = the five; exempt-no-tail = 23; and the sentence "the shared tail named in the roadmap does not exist as repeated code: `lazyApp` and `TestClock` are already single calls/options of `TestAuth`; only the events subscriber repeats." Net lines (estimate, not measured): removed 19 + 12 + 10 = 41 (incl. comments), added about 22 helper + 3 call lines + 3 import lines, so about -13 before the guard test and the type pin (which are new, additive files). Like Phase 6's `unavailable-label` helper (`ADOPTION-DELTA ... net=-2`, "kept because the closure now lives in one place (locality), not because it shrank the code"), this is kept for locality of a reproduced-race comment, and the planner should state that rather than claim a size win. If the orchestrator prefers the pure table-only no-go, WORLD-01's "a scaffold ... supplies" clause is then recorded as not pursued with this section as the reason; that is also D-05-compliant ("the honest outcome is a smaller scaffold plus a table, and that is recorded, not padded").

### Interface (proposed)

Module `features/step-definitions/shared/EventCapture.ts`, one export:

```typescript
export const captureEvents: <E extends AuthEvents.PublishedAny = AuthEvents.PublishedAny>(
  into: Ref.Ref<ReadonlyArray<E>>,
  keep?: (event: AuthEvents.PublishedAny) => event is E,
) => Layer.Layer<never, never, AuthEvents.AuthEvents>
```

- **What it hides:** the subscription timing (`startImmediately`, the lost-publish race), the `Ref.update` append, the optional narrowing filter. Callers pass only the target `Ref` and, in Admin, the filter.
- **What it does not touch:** `Auth.make`, `TestAuth.layer`, `TestAuth.serve`, `TestAuth.lazyApp`, the `World` tag, `AppHandle` shapes, clocks. Each adopting World still passes the result where it passes the inline layer today: Admin as `taps: eventsLayer` (`AdminWorld.ts:124`), Password inside `services: Layer.mergeAll(..., eventsLayer)` (`PasswordWorld.ts:184`), Domain at `DomainWorld.ts:229`.
- **Behaviour preservation (D-04):** same layer order (the layer is placed exactly where the inline one is), same registration (`authEvents.stream` + `forkScoped({ startImmediately: true })`, unchanged), same filter (Admin's `Stream.filter(AuthEvents.is(worldEvents))` before `runForEach`), same append. Domain's target is `probes.events` (a `Ref.makeUnsafe` in `makeProbes`, `DomainWorld.ts:~183`), passed as `into`.
- **Not adopted:** `OrganizationWorld` keeps its inline `subscribe` layer (different registration); the doc comment in the helper names this so a future reader does not "finish the migration".

### How the compile-error-on-missing-plugin gate is preserved (type-level evidence read from the code)

1. The gate lives in `TestAuth.layer`'s return type: `Layer.Layer<Provided<...> | Layer.Success<Auth.Built<P, Extra>["layer"]>, SE, Requires<P, Extra, "memory", S, SR, T, D, DR>>` [VERIFIED: `packages/test/src/internal/composition.ts:253-269`, quoted `): Layer.Layer<` / `Provided<P, "memory", S, D> | Layer.Success<Auth.Built<P, Extra>["layer"]>,` / `Requires<P, Extra, "memory", S, SR, T, D, DR>`], and its doc comment states the contract: "Its `RIn` is `never` exactly when the composition is complete" (`:247`).
2. The enforcement point in a World is `TestAuth.serve`, whose parameter is `composition: Layer.Layer<A | AppNeeds, E>` (third parameter `RIn` defaulted to `never`) [VERIFIED: `appHarness.ts:258-261`, quoted `export const serve = <A, E>(` / `composition: Layer.Layer<A | AppNeeds, E>,`], so a layer with an unmet requirement does not type-check at the call (`AdminWorld.ts:147`, `PasswordWorld.ts:155-156`).
3. The scaffold returns `Layer.Layer<never, never, AuthEvents.AuthEvents>`: `ROut = never`, `E = never`, `RIn = AuthEvents`. Today's inline copies have exactly that type (`OrganizationWorld.ts:76` annotates the identical shape for its own: `eventsLayer: Layer.Layer<never, never, AuthEvents.AuthEvents>`; `AdminWorld.ts:111-125` passes the inline one as `taps` and the World compiles). `TestAuth.layer`'s `taps?: Layer.Layer<never, never, T>` [VERIFIED: `composition.ts:111`] receives the same `T = AuthEvents.AuthEvents` as before, so `Requires<...>` is computed from the same inputs. The `ROut = never` also means `AppServices = Layer.Success<ReturnType<typeof buildAppLayer>>` (`AdminWorld.ts:134`) is unchanged.
4. Existing gates that must keep passing, unedited: `features/step-definitions/{CompileTimeGates,PluginTypeGates,ContractTypeGates,PersistenceTypeGates}.ts` and `packages/test/test/TestAuthRecords.types.test.ts` (its `memoryIsClosed`/`sqlIsClosed` closed-composition checks and the `@ts-expect-error` on a foreign tap, `:15-41`). They are typechecked by `npx tsc -p tsconfig.test.json` and `features`' `tsc -b`.

**The type-level pin for D-03** (a typechecked, never-run file; it must not be one of the gate files above, because `CompileTimeSteps` reads those by `// type-gate:` marker and tying a new gate to a scenario would change the scenario count, D-04): `features/step-definitions/shared/EventCapture.types.ts`, with three claims, each a `tsc` assertion:

```typescript
// (1) the scaffold needs only AuthEvents: exact, both directions (the form of PluginTypeGates.ts:195-203)
export const needsOnlyAuthEvents: [Layer.Services<ReturnType<typeof captureEvents>>] extends [AuthEvents.AuthEvents]
  ? [AuthEvents.AuthEvents] extends [Layer.Services<ReturnType<typeof captureEvents>>] ? true : false
  : false = true;
// (2) a complete composition with the scaffold in `taps` is still closed (RIn never)
export const stillClosed: Layer.Layer<unknown, unknown, never> =
  TestAuth.layer(Auth.make([Password.Password]), { taps: captureEvents(Ref.makeUnsafe([])) });
// (3) an incomplete one still does not compile: a tap on a point nothing provides, beside the scaffold
export const stillRefused = () =>
  // @ts-expect-error - `Undeclared` is required by the tap and nothing in the composition provides it
  TestAuth.serve(TestAuth.layer(built, { taps: Layer.mergeAll(captureEvents(ref), Undeclared.tap(() => Effect.void)) }));
```
(1) and (2) follow the structure of `PluginTypeGates.ts:195-203` and `TestAuthRecords.types.test.ts:15-16`; (3) follows `TestAuthRecords.types.test.ts:36-41`. [ASSUMED: all three compile as sketched; the sketch has not been compiled. Wave 0 must write the file against the helper before any World is edited and confirm (1) and (2) are green and (3) is red without the `@ts-expect-error`.] The file is under `features/tsconfig.json`'s `include: ["step-definitions/**/*.ts"]` [VERIFIED: `features/tsconfig.json:3`] and `knip.json` lists `step-definitions/**/*.ts` as `features` entries, so it adds no unused-file row.

**A mutation check for "omitting a plugin from a scaffolded World is still a compile error"** (the Phase 6 `06-05` precedent was a scratch mutation of a pin): in a scaffolded World with more than one plugin (`DomainWorld`'s `Auth.make([Profile, Password.Password])`, header comment `:196`), drop `Password.Password` from the tuple, run `pnpm --filter @awthaq/features typecheck` (`tsc -b tsconfig.json && tsc -p tsconfig.test.json`), record red (a step that yields the `Password` service no longer type-checks, and `TestAuth.serve` is refused if a service the layer needs is no longer provided), then restore byte for byte. The executor runs and records it; this research did not (read-only).

### LeakGuard accounting preserved

`LeakGuard` reads `TestAuth.openApps()` and `TestSql.openClients()` after each feature file and throws when either is above zero [VERIFIED: `features/step-definitions/shared/LeakGuard.ts:12-23`, quoted `while ((TestAuth.openApps() > 0 || TestSql.openClients() > 0) && Date.now() < deadline)`], and prints one line per file: `` `[leak-guard] ${relative} apps=${apps} sqlClients=${clients}` `` (`:20`). The counter is incremented in `make` and decremented in `release` (`appHarness.ts:247`, `openAppCount--`), both inside `serve`. The scaffold never calls `serve`, `listen`, `withApp` or `lazyApp`, so the counter has no new writer by construction. The executable proof: capture `pnpm test:bdd 2>&1 | grep '\[leak-guard\]' | sort` at Wave 0 and at close; the two lists must be identical (39 files, every line `apps=0 sqlClients=0`). Note the existing exception: Worlds on `CrossCuttingApp` (Hooks, Events, RateLimiting) never go through `serve` and are not counted today either; that does not change.

## Q3: Credentials.ts anatomy and the split

### Public namespace (exact names and kinds)

`export * as Credentials from "./Credentials.ts";` (`packages/server/src/index.ts:20`) makes every export of the file a namespace member. The 30 exports, kind per the checker probe (`[value]` 14, `[type]` 12, `[value+type]` 4) [VERIFIED: probe output, `## <name> [<kind>]` headings, run this session]:

| Name | Kind | Declared at | Target internal module |
|------|------|-------------|------------------------|
| `PrincipalResolverShape` | type (interface) | `:45` | `PrincipalResolver.ts` |
| `PrincipalResolver` | value+type (class) | `:51` | `PrincipalResolver.ts` |
| `PrincipalResolverLive` | value | `:82` | `PrincipalResolver.ts` |
| `PrincipalResolverWithUserFactsLive` | value | `:94` | `PrincipalResolver.ts` |
| `ClaimCarrier` | type | `:117` | `CredentialResolvers.ts` |
| `CredentialResolverContribution` | type (interface) | `:134` | `CredentialResolvers.ts` |
| `DuplicateCredentialResolver` | value+type (class, `Data.TaggedError`) | `:149` | `CredentialResolvers.ts` |
| `CredentialResolversFrozen` | value+type (class) | `:156` | `CredentialResolvers.ts` |
| `CredentialResolversShape` | type (interface) | `:160` | `CredentialResolvers.ts` |
| `CredentialResolvers` | value+type (class) | `:180` | `CredentialResolvers.ts` |
| `CredentialResolversLive` | value | `:185` | `CredentialResolvers.ts` |
| `contribute` | value | `:229` | `CredentialResolvers.ts` |
| `Carrier` | type | `:265` | `Presented.ts` |
| `SessionCarrier` | type | `:267` | `Presented.ts` |
| `Presented` | type | `:273` | `Presented.ts` |
| `Source` | type (interface) | `:276` | `Presented.ts` |
| `presented` | value | `:305` | `Presented.ts` |
| `fromRequest` | value | `:316` | `Presented.ts` |
| `Tier` | type (interface) | `:325` | `Presented.ts` |
| `tier` | value | `:330` | `Presented.ts` |
| `userTier`, `optionalTier`, `machineTier` | value x3 | `:342-344` | `Presented.ts` |
| `Rotation` | type (interface) | `:349` | `Resolution.ts` |
| `Scope` | type (interface) | `:356` | `Resolution.ts` |
| `Resolved` | type | `:369` | `Resolution.ts` |
| `principalFields` | value | `:429` | `Resolution.ts` |
| `make` | value | `:442` | `Resolution.ts` |
| `httpScope` | value | `:649` | `Scopes.ts` |
| `collecting` | value | `:669` | `Scopes.ts` |

Count check by internal module: PrincipalResolver 4, CredentialResolvers 8, Presented 11 (`Carrier` to `machineTier`, with the three tiers), Resolution 5, Scopes 2: 4 + 8 + 11 + 5 + 2 = 30.

Quoted for the record, the probe's headings (alphabetical, `localeCompare`): `Carrier [type]`, `ClaimCarrier [type]`, `collecting [value]`, `contribute [value]`, `CredentialResolverContribution [type]`, `CredentialResolvers [value+type]`, `CredentialResolversFrozen [value+type]`, `CredentialResolversLive [value]`, `CredentialResolversShape [type]`, `DuplicateCredentialResolver [value+type]`, `fromRequest [value]`, `httpScope [value]`, `machineTier [value]`, `make [value]`, `optionalTier [value]`, `presented [value]`, `Presented [type]`, `principalFields [value]`, `PrincipalResolver [value+type]`, `PrincipalResolverLive [value]`, `PrincipalResolverShape [type]`, `PrincipalResolverWithUserFactsLive [value]`, `Resolved [type]`, `Rotation [type]`, `Scope [type]`, `SessionCarrier [type]`, `Source [type]`, `tier [value]`, `Tier [type]`, `userTier [value]`.

### Internal (not exported) members

All `const`/`type` below are file-private today and must stay un-exported from the facade: `userPrincipalOf` (`:63`), `findClaim` (`:238`), `resolveClaimed` (`:252`), `isCarrier` (`:269`), `nonEmpty` (`:281`), `bearerCredential` (`:287`), `isUser` (`:337`), `isAny` (`:339`), `Failure` (type, `:378`), `sessionMemo` (`:385`), `claimMemo` (`:389`), `outages` (`:397`), `once` (`:399`), `annotatePrincipal` (`:435`), `rotationDelivery` (`:611`). Of these, exactly one crosses a new file boundary: `resolveClaimed` (defined with the registry, used by `httpScope.claim` at `:662`), so it becomes an export of the internal registry module and is not re-exported by the facade. `Failure` is used by the memo tables, `once`, `make` and `resolve` (all in `Resolution.ts`) and by no other seam.

### Import graph

Who imports `Credentials` (31 files, found by grep on the import forms) [VERIFIED: grep this session]:

| Area | Files | How |
|------|------:|-----|
| `packages/server/src` | 3 | `import * as Credentials from "./Credentials.ts"` (`Authentication.ts:22`, `AuthHttp.ts:46`, `AuthHost.ts:52`) |
| `packages/server/test` (+ `support`) | 7 | `import * as Credentials from "../src/Credentials.ts"` (`Authentication.test.ts:43`, `CredentialResolvers.test.ts:26`, `AuthHost.test.ts:25`, `MiddlewareFor.test.ts:18`, `Credentials.test.ts:19`, `support/Wiring.ts:10`, `support/CredentialTable.ts:12`) |
| `packages/api-key/src` | 1 | `import { Credentials } from "@awthaq/server"` (`ApiKey.ts:58`) |
| `packages/jwt` | 3 | `Jwt.ts:54` (src) and 2 tests |
| `packages/qadi` | 2 | `SubjectExtractor.ts:21` (src) and 1 test |
| `packages/web` | 2 | `Session.ts:38` (src) and 1 test |
| `packages/next/test` | 2 | tests |
| `packages/test` | 2 | `src/internal/composition.ts` (the `principalResolver` option, `:114-119`; `Credentials.PrincipalResolver`) and 1 test |
| `features/step-definitions` | 8 | 7 Worlds/Steps plus `shared/ResolveCredential.ts` |
| `examples/memory-server` | 1 | `app.ts` |

Members used outside `Credentials.ts` and their uses [VERIFIED: grep]: `PrincipalResolver` 29, `PrincipalResolverLive` 26, `fromRequest` 21, `make` 19, `httpScope` 19, `userTier` 18, `contribute` 13, `machineTier` 9, `CredentialResolversLive` 9, `Carrier` 6, `PrincipalResolverWithUserFactsLive` 5, `CredentialResolvers` 5, `optionalTier` 4, `tier` 3, `resolve` 3 (a field of `make`'s result), `presented` 3, `collecting` 3, `Rotation` 2, `Tier` 1, `step` 1 (field of `make`'s result), `Resolved` 1, `principalFields` 1, `Presented` 1, `ClaimCarrier` 1. Names with no external use today: `PrincipalResolverShape`, `CredentialResolverContribution`, `DuplicateCredentialResolver`, `CredentialResolversFrozen`, `CredentialResolversShape`, `SessionCarrier`, `Source`, `Scope`. They are still public namespace members (they appear in the signatures of used members and in the `.d.ts`); D-06 forbids dropping any.

How the namespace is exported: a star-as re-export from `index.ts:20`; no object literal, no TypeScript `namespace`. **Facade pattern:** keep `Credentials.ts` as the file `index.ts` and 8+ tests import (`../src/Credentials.ts` is imported directly by 7 server test files, so the path cannot move), with a header comment and 30 explicit named re-exports (values with `export { ... } from`, types with `export type { ... } from`, because `verbatimModuleSyntax: true`).

Cross-module imports inside the split (all inside `packages/server/src`; imports of external packages stay as they are in the lines `:17-35`):

| Internal module | Imports from siblings | External imports needed |
|-----------------|-----------------------|-------------------------|
| `PrincipalResolver.ts` | none | `Sessions`, `Users` (`@awthaq/core`), `Api`, `Context`, `DateTime`, `Effect`, `Layer`, `Option` |
| `CredentialResolvers.ts` | none | `Api`, `Context`, `Data`, `Effect`, `Layer`, `Option`, `Redacted`, `Ref`, `HttpServerRequest` |
| `Presented.ts` | none | `SessionCookie` (`@awthaq/core`), `Api`, `Option`, `Record`, `Redacted`, `Headers`, `HttpServerRequest`, type `HttpApiSecurity` |
| `Resolution.ts` | `PrincipalResolver` (value), `CredentialResolvers` (type `ClaimCarrier`), `Presented` (types `Carrier`, `SessionCarrier`, `Presented`, `Tier`) | `Observability`, `Sessions` (`@awthaq/core`), `Api`, `Deferred`, `Effect`, `Option`, `Predicate`, `Redacted` |
| `Scopes.ts` | `Resolution` (types `Rotation`, `Scope`), `CredentialResolvers` (value `resolveClaimed`) | `SessionCookie`, `Api`, `Effect`, `Option`, `Redacted`, `Ref`, `Cookies`, `HttpEffect`, `HttpServerRequest`, `HttpServerResponse` |

Resulting edges: `Resolution -> {PrincipalResolver, CredentialResolvers, Presented}`, `Scopes -> {Resolution, CredentialResolvers}`, `Credentials -> all five`; no edge back to `Credentials.ts` (Pitfall 2). Dead-import check: the lines `:17-35` contain imports that become unused in the facade (everything); the facade needs none of them, only the five `from "./internal/..."` clauses.

### Natural seams (with sizes)

| Seam | Lines in `Credentials.ts` | About | Cohesion |
|------|---------------------------|------:|----------|
| Principal resolver | `:37-110` | 74 | BEH-EA-069/APS-007: session to principal mapping, two layers |
| Claimed-credential registry | `:112-260` | 149 | ADR-EA-012 registry: contributions, freeze, `contribute`, claim lookup |
| What a request presents, and tiers | `:262-344` | 83 | pure: carrier names, header/cookie read, tier declarations |
| The resolution engine and the `Scope` seam types | `:346-586` | 241 | the memo tables, outage record, `make` (`verified`, `viaSession`, `viaClaim`, `step`, `resolve`) |
| The two scopes | `:588-678` | 91 | `rotationDelivery` (private), `httpScope`, `collecting` |

Total 74 + 149 + 83 + 241 + 91 = 638, plus the 40-line header and imports = 678.

### What ADR-EA-042 pins

[VERIFIED: read `spec/decisions/042-credential-resolution-module.md` in full; Document Control quoted: `| Revision | 1.2 |`, `| Effective Date | 2026-10-18 |`] Decision 1: "One module, `Credentials`, in `@awthaq/server`. It reads what a request presents (`presented`), picks a tier derived from the middleware declaration (`tier(declaration, admits)`), and runs either one carrier (`step`) or the whole chain (`resolve`, a fold over the tier's carriers). Its implementation holds everything the copies shared: the per-request single-flight memo ..., the outage short-circuit, the impersonation rule, tier admission, the rotation hand-off, spans and logs." Decision 2: "A `Scope` seam with two adapters. `httpScope(request)` keys the memo on `request.source` ... `collecting` is a framework call." Decision 5: "The impersonation rule is judged on the session (`actingAs`), before the `PrincipalResolver`, for every entry point." Decision 6: claimed credentials join the per-request memo. It pins a **module in `@awthaq/server` named `Credentials` with those members and behaviours**; it does not pin a file path, a file count or an internal layout, and it names no `Credentials.ts` line. A split that keeps `export * as Credentials` and the 30 names satisfies it unchanged. No ADR edit is needed (D-07). If a planner finds one is, the rule is to stop and record it.

### How to prove the public surface is unchanged

1. **Export-name and shape diff (the proof).** Reuse the Phase 2 probe [VERIFIED: source recorded verbatim in `.planning/phases/02-split-testauth/02-01-PLAN.md:88-131`; run this session from a scratch directory outside the repo, never committed because a committed `.cjs` is a new knip "Unused files" row]:
   ```bash
   # Wave 0, BEFORE any packages/server/src change; probe lives outside the repo (mktemp -d)
   TS_API_PATH="$PWD/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript" \
     node "$TMP/surface-probe.cjs" packages/server/src/Credentials.ts packages/server/tsconfig.src.json \
     > .planning/phases/07-world-scaffold-and-credentials-split-optional/07-CRED-SURFACE-BEFORE.txt
   # after the split, same command to 07-CRED-SURFACE-AFTER.txt, then:
   diff .planning/phases/07-.../07-CRED-SURFACE-BEFORE.txt .planning/phases/07-.../07-CRED-SURFACE-AFTER.txt   # must print nothing
   ```
   The probe here takes the entry file and the tsconfig as arguments (the Phase 2 version hard-coded `packages/test/tsconfig.src.json`; the only change is `path.join(root, process.argv[3])`). Expected before-snapshot (measured here): 30 `## ` headings, 14 `[value]`, 12 `[type]`, 4 `[value+type]`, 0 `import(`, 81 lines, `sha256 efbf9b94e28774245a5630cdc2f9b1f3a17ccfe5b810211176af9ac31a7a9a1d`, deterministic over two runs. An executor on the same tree must reproduce that hash; a different hash at Wave 0 means the tree differs from this research and the planner must re-measure.
2. **Facade-level check.** After the split, `Credentials.ts` must contain no `export *` and no declaration other than re-exports: `grep -c 'export \*' packages/server/src/Credentials.ts` prints 0 (a `export * as` would be a different shape too).
3. **Runtime key pin.** `Object.keys(Credentials).sort()` equals the 18 value-bearing names (14 `[value]` + 4 `[value+type]`) as an inline literal, following `TestAuthSurface.test.ts` (Phase 2). This pin is committed in `packages/server/test/` and green against the untouched file before the split (Wave 0, one commit, never edited afterwards). [ASSUMED: a runtime-key pin is wanted; Phase 2 CONTEXT chose it for `TestAuth`; it is the one new test file in the phase for C8.]
4. **`.d.ts` shape.** Phase 6's `06-SHAPE-DTS.sha256` approach hashes `lib/*.d.ts` and works only for files that do not change. `lib/Credentials.d.ts` will change (re-export lines instead of declarations), so the byte hash of that one file is expected to change; the probe diff in (1) is the substitute. Optionally record `shasum -a 256 packages/server/lib/{Authentication,AuthHost,AuthHttp,Csrf,Session,SessionDelivery,SessionLifecycle,RequestContext,Account,BodyLimit,SecurityHeaders,index}.d.ts` before and after to show the neighbouring modules are untouched: their text embeds types from `Credentials` by import path (`import("./Credentials.ts")`), which the split must not change; if a neighbour's `.d.ts` changes, record why.
5. **Consumers compile without edits.** `git diff --name-only <phase base> HEAD -- packages/api-key packages/jwt packages/qadi packages/web packages/test packages/next features examples` must print no `Credentials`-importing file for C8, and `npx tsc -b tsconfig.json` plus `npx tsc -p tsconfig.test.json` pass (the second typechecks `server/test`, `jwt/test`, `qadi/test`, `web/test`, `next/test`, `test/test`, `features`).
6. **Behaviour.** `packages/server/test/Credentials.test.ts` (the 23-request-shape table x 3 tiers) and `Authentication.test.ts` (the same table served over Path A) are the behavioural proof and stay unedited; run `npx vitest run packages/server packages/qadi packages/web packages/jwt packages/api-key packages/next` plus the bdd suite.

### Circular-import and knip risks

- **`pnpm circular`** [VERIFIED: `scripts/circular.mjs:1-15`, comment quoted: "a cycle that only exists through `import type` is still a cycle ... (ELC-003: AuditLog <-> AuthEvents was exactly that)"] counts type-only cycles. Internal modules must never import `../Credentials.ts`; shared types (`Rotation`, `Scope`, `ClaimCarrier`, `Carrier`) live in the modules in the DAG above and the facade re-exports them. The DAG in the table above is acyclic by construction; the check is `pnpm circular` exit 0.
- **knip** [VERIFIED: `knip.json`; no `ignoreExportsUsedInFile` for `packages/server`, which is set only for `packages/cli`]: an internal export used only inside its own file is an "unused export" row. So: export from an internal module only what another module imports (`resolveClaimed`, the types and values the facade re-exports, `Rotation`/`Scope`/`Resolved`/`ClaimCarrier`/`Carrier`/`SessionCarrier`/`Presented`/`Tier`). Keep `Failure`, `once`, the memo tables, `findClaim`, `userPrincipalOf`, `rotationDelivery`, `isCarrier`, `nonEmpty`, `bearerCredential`, `isUser`, `isAny`, `annotatePrincipal` un-exported. Every name re-exported by the facade is reachable from `index.ts` through `export * as Credentials`, so knip counts it used (the same reason the 8 names with no external consumer pass knip today). The close gate is the filtered knip output unchanged (banner, headings, the 3 `readme-quickstart.ts` rows, ELIFECYCLE) with `git diff --stat knip.json` empty.
- **Source-scan census tests** read every `packages/*/src/**/*.ts` and count patterns per file [VERIFIED: `packages/core/test/RequestContextSeams.test.ts:16-31` reads `readdirSync(src, { recursive: true })`; the patterns counted in `server/src` files are `ClientAddress`, `clientAddress.resolve(`, `"user-agent"`, `remoteAddress`, `Layer.succeed(Api.AuthRequestContext`, `AuthRequestContext.noRequest`]. `Credentials.ts` contains none of them [VERIFIED: `grep -nE "ClientAddress|clientAddress|\"user-agent\"|remoteAddress|noRequest|Layer\.succeed\(\s*Api\.AuthRequestContext|configInForce"` over `Credentials.ts` printed nothing], so the census (an exact per-file allow-list) is unaffected. `ConfigScope.guard.test.ts` (`packages/core/test/ConfigScope.guard.test.ts:~44`) looks for `Context.(Reference|Service)` keys ending `Config|Policy|Overrides`; the two services here are `awthaq/server/PrincipalResolver` and `awthaq/server/CredentialResolvers`, no match.
- **`export type` under `verbatimModuleSyntax`.** The 12 pure-type names (`[type]` in the probe: `PrincipalResolverShape`, `ClaimCarrier`, `CredentialResolverContribution`, `CredentialResolversShape`, `Carrier`, `SessionCarrier`, `Presented`, `Source`, `Tier`, `Rotation`, `Scope`, `Resolved`) must go through `export type { ... } from`; the 4 classes (`[value+type]`) and the 14 values go through `export { ... } from`.
- **TS2883** (declaration emit cannot name an inferred type) [CITED: 06-RESEARCH.md Q2, "documented in this repo as a narrow exception handled by naming the type in the owning module"]. The unannotated consts that move (`PrincipalResolverWithUserFactsLive`, `CredentialResolversLive`, `contribute`, `presented`, `userTier`, `make`, `httpScope`, `collecting`) have inferred types that reference `effect/...` and `@awthaq/...` types; they already emit today from a sibling directory pattern (`internal/SessionDto.ts` infers `toSessionDto`'s type). [ASSUMED: low risk; `npx tsc -b` per task is the detector.] `PrincipalResolverLive` carries an explicit annotation `Layer.Layer<PrincipalResolver>` (`:82`) which moves verbatim.
- **Package contents.** `packages/server/package.json` `files: ["lib", "src", "README.md"]` and a single `.` export [VERIFIED: `package.json`], so new `internal/` files ship as before (3 already do) and are not importable by consumers. `pnpm package:smoke` and `pnpm check:readmes` are run as gates; the README status check keys on package state, not file layout.

### Changeset and spec decisions to record (D-08)

- **No changeset** is the recommended decision: `@awthaq/server` exports only `.`, the public surface diff is empty, and Phase 2 recorded the identical decision for its split ("No changeset: the probe diff ... is empty and `packages/test/package.json` exports only `.`, so no change is package-visible; GATE-03 binds package-visible changes", `02-05-SUMMARY.md:33`, `:105`). `git diff --name-only <base> HEAD -- .changeset` must stay empty. The published `lib/Credentials.d.ts` text changes, but nothing a consumer can import changes; record this sentence in the phase summary.
- **No spec edit**: no spec or docs line cites `packages/server/src/Credentials.ts` [VERIFIED: grep, no hit] and ADR-EA-042 pins no path. `spec/overview.md` and `spec/traceability.md` (the `Credentials.test.ts` rows name tests, which do not move) need no Revision bump. `pnpm spec:verify:strict` must stay `PASS 32 FAIL 0 SKIP 0`.
- The comment in `packages/server/src/index.ts:5-7` ("Implemented: Credentials.ts (the one credential-resolution module, ADR-EA-042 ...") stays true; do not edit it.

## Q4: Gates, baseline numbers and commands

Baseline source and rule: `06-BASELINE.md` (table shape "Gate | Command | Exit | Summary line printed | Wall time"; "Phase-close comparison rule"). The numbers below are **the Phase 6 close figures** [VERIFIED: `06-12-SUMMARY.md:61-63` and `06-VERIFICATION.md:165`]; Phase 6's review fixes ran afterwards (`06-REVIEW-FIX.md`), so **Wave 0 must re-record every gate at the Phase 7 planning HEAD (`d4556566`) as `07-BASELINE.md`**, with the precondition `git diff --quiet 3be32564 -- ...` replaced by a Phase 7 base (HEAD at Wave 0) and `git status --short` recorded as found.

| Gate | Command | Phase 6 close value (compare against the re-recorded one) |
|------|---------|-------------------------------------------------------------|
| tsc -b | `npx tsc -b tsconfig.json` | exit 0, 0 `error TS` |
| tests typecheck | `npx tsc -p tsconfig.test.json` | exit 0; 2 pre-existing `warning TS377149` in `features/step-definitions/TestingHarnessSteps.ts` (lines 851, 853 at the Phase 6 baseline; the lines may have moved) |
| circular | `pnpm circular` | exit 0, no findings |
| error tags | `pnpm check:error-tags` | `error-tags: 163 internal and 137 wire error tags, none shared` |
| transactions | `pnpm check:transactions` | `check-transactions: no bare sql.withTransaction in packages/*/src` |
| contract tests | `pnpm check:contract-tests` | `contract-tests: all 21 plugin classes run the contract suite; @awthaq/test stays dev-only` |
| lint | `pnpm lint` | exit 0; warnings only (87 under untracked `.claude/`, 7 in `features/step-definitions/RequestContextSteps.ts`), none under `packages/` |
| format | `pnpm format:check` | exit 0 (1233 files at Phase 6 close; the count grows with new files) |
| readmes | `pnpm check:readmes` | `readme-status: every package README matches its package's shipped state` |
| workspace | `pnpm workspace:check` | `sync-workspace: 29 packages and 3 examples match every roster` |
| bdd (SQLite) | `pnpm test:bdd` | **Test Files 39 passed (39); Tests 1580 passed, 44 skipped (1624)** |
| bdd (Postgres) | `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq pnpm test:bdd` | 1580 passed / 44 skipped |
| unit (SQLite) | `pnpm test` | 428 files + 6 skipped; 6727 passed, 1 expected fail, 23 skipped |
| unit (Postgres) | `AWTHAQ_POSTGRES_URL=... pnpm test` | 434 files; 6770 passed, 1 expected fail, 1 skipped |
| coverage | `pnpm coverage` | 91.81 / 85.31 / 87.13 / 92.33 (floors 89 / 83 / 84 / 90) |
| spec | `pnpm spec:verify:strict` | `PASS: 32   FAIL: 0   SKIP: 0` |
| knip | `pnpm knip` | exit 1 (pre-existing); filtered `pnpm knip 2>&1 | grep -v '^\.claude/' | grep -v '^\.reports/'` = banner, `Unused files (39)`, `Unlisted dependencies (3)` with the three `readme-quickstart.ts` rows, ELIFECYCLE; `git diff --stat knip.json` empty |
| package smoke | `pnpm package:smoke` | 30 PASS |

**Expected deltas for this phase** (record them in the phase-close table so a delta is not read as drift):
- **bdd test files 39 -> 40 and passed 1580 -> 1581** if the World-table guard lives at `features/features/_guard/world-table.steps.test.ts` (the `_guard/` precedent file `step-patterns.steps.test.ts` is already one of the 39: `ls features/*/*.steps.test.ts | wc -l` prints 39 [VERIFIED]). The scenario count (Gherkin) is unchanged, which is the D-04 statement; the `skipped` count (44) must not change. If the orchestrator prefers the guard to add no file, put the case into the existing guard file instead (then files stay 39, passed 1581); either way state it.
- **unit**: one new `packages/server/test/` file for the runtime-key pin (+1 file, +1 test, SQLite and Postgres alike).
- **format**: +2 or +3 files for C3 (`EventCapture.ts`, `EventCapture.types.ts`, the guard test), +1 for the server pin, +5 internal modules for C8.

**Phase-specific pin commands**
- Credentials: `npx tsc -b tsconfig.json && npx vitest run packages/server packages/qadi packages/web packages/jwt packages/api-key packages/next packages/test` (the packages that import `Credentials`, 31 files), then the probe diff (Q3).
- Worlds: `npx tsc -b tsconfig.json && npx tsc -p tsconfig.test.json && pnpm test:bdd`, then `pnpm test:bdd 2>&1 | grep '\[leak-guard\]' | sort` before and after (identical).
- Postgres: container `awthaq-p3-pg` is up (`docker exec awthaq-p3-pg pg_isready -U postgres` printed `/var/run/postgresql:5432 - accepting connections`; `ShmSize` 1073741824) [VERIFIED: executed]. Recreate before each full Postgres run, with the same shape as Phase 6 [ASSUMED: `pg-fresh.sh` is a local scratch script not in the repo; the shape is `docker rm -f awthaq-p3-pg && docker run -d --name awthaq-p3-pg --shm-size=1g -p 55433:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=awthaq postgres:16`, inferred from the URL `postgres://postgres:pw@localhost:55433/awthaq` and 06-BASELINE "Postgres"]; never `scripts/test-pg.sh`. Record each leg as "run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)".
- `DomainWorld` runs `TestAuth.layer({ records: "sql" })` (`:221`) and `PasswordWorld` uses `suite: "features_PasswordWorld"` (`:215`), so the Postgres bdd leg is a real check of the scaffolded Worlds' event capture under socket I/O, not a formality.

**Known flaky tests** [VERIFIED: 06-BASELINE "Known intermittents" and the orchestrator decision after 06-04]: (1) passkey `ChallengeStore ... consume [atomic]: false for any other value, a tampered one included`; (2) `packages/organization/test/TenantMiddleware.test.ts > ... a suspended organization still resolves`; (3) the admin `ImpersonationRecords (sql)` pair `create [atomic]` / `create [race]` (5 s timeouts in full Postgres runs). Rule unchanged: a command whose only failures are these is re-run at most twice and every run recorded.

**Path allowlist for phase close** (adapted from Phase 5 and 6). Every line of `git diff --name-only <phase base> HEAD` must match:
```text
^(\.planning/|features/step-definitions/shared/EventCapture(\.types)?\.ts$|features/features/_guard/world-table\.steps\.test\.ts$|features/step-definitions/(AdminWorld|PasswordWorld|DomainWorld)\.ts$|features/STYLE\.md$|packages/server/src/Credentials\.ts$|packages/server/src/internal/(PrincipalResolver|CredentialResolvers|Presented|Resolution|Scopes)\.ts$|packages/server/test/CredentialsSurface\.test\.ts$)
```
and `git diff --quiet <base> HEAD -- packages/test packages/*/package.json pnpm-lock.yaml knip.json .changeset spec docs examples` exits 0; the five hand-wired Worlds have an empty diff (`git diff --name-only <base> HEAD -- features/step-definitions/{AuthenticationWorld,ContractStratumWorld,CsrfWorld,QadiBridgeWorld,TenancyWorld}.ts` prints nothing). If the orchestrator takes the table-only no-go, drop the C3 source paths from the allowlist. (`features/STYLE.md` is listed only if the planner adds the one-line pointer to the helper under "World lifetime"; `CredentialsSurface.test.ts` is the proposed name of the runtime-key pin.)

## Common Pitfalls

### Pitfall 1: A World wrapper that looks like a convenience and erases the gate
**What goes wrong:** a `hostFor(built, options)` that forwards to `TestAuth.layer` is implemented against a widened signature and its callers lose the "incomplete composition does not compile" error, silently.
**Why it happens:** `TestAuth.layer`'s precision comes from three overloads with 8 type parameters and `Requires<...>`; its own doc says a generic wrapper "cannot simplify its own abstract `Validate<P>` back to a concrete tuple" (`composition.ts:232-238`, paraphrase of the comment on `Auth.make` forwarding).
**How to avoid:** the scaffold returns a layer and never sees the plugin tuple (Q2). The type pin (1)-(3) is the detector.
**Warning signs:** a scaffold file importing `Auth`, `AuthPlugin` or `TestAuth.CommonOptions`.

### Pitfall 2: A facade that the internal modules import back
**What goes wrong:** `Resolution.ts` imports `type { Scope }` from `../Credentials.ts` because that is where the type is "public"; `madge` with type-only imports counted reports a cycle.
**How to avoid:** every internal module imports from the sibling that defines the thing; the facade is a leaf of the graph.
**Warning signs:** an `import ... from "../Credentials.ts"` anywhere under `internal/`.

### Pitfall 3: `export *` in the facade
**What goes wrong:** private helpers (`once`, `resolveClaimed`, the memo `WeakMap`s) become public namespace members, the probe diff is non-empty and `Credentials.once` becomes a compile-visible API.
**How to avoid:** 30 explicit named re-exports; `grep -c 'export \*' Credentials.ts` = 0.

### Pitfall 4: Separating the memo tables from `make`
**What goes wrong:** `sessionMemo`, `claimMemo`, `outages` and `once` are module-level singletons keyed by `scope.key` (`request.source`); the single-flight guarantee (a rotating `verify` runs once per request under any interleaving, one API-key throttle charge, PCS-006/TS-003) holds only because one function reads them. A second module holding its own table would run the verify twice.
**How to avoid:** the tables, `once`, `Failure`, `annotatePrincipal` and `make` live in the same file (`Resolution.ts`); `httpScope`/`collecting` never touch them (they only set `key`).
**Warning signs:** `new WeakMap` in more than one internal file; `Credentials.test.ts` T-rows for single-flight failing.

### Pitfall 5: `verbatimModuleSyntax` and `export type`
**What goes wrong:** `export { Rotation } from ...` for an interface is a TS1205/TS1371-class error under `verbatimModuleSyntax: true`; the first `tsc -b` after the move fails.
**How to avoid:** types through `export type { ... } from`, classes (which are both) through `export { ... } from`. The probe's `[type]` / `[value+type]` split in Q3 is the checklist.

### Pitfall 6: Mistaking the Organization subscriber for a copy
**What goes wrong:** adopting `captureEvents` in `OrganizationWorld` changes registration from `authEvents.subscribe` (registers now, in the layer's scope, `OrganizationWorld.ts:121-127`) to `stream` + `forkScoped({ startImmediately: true })`. Both avoid a missed first event, but the semantic is different and a step may depend on it; D-04 says behaviour-preserving.
**How to avoid:** leave it inline; the table records it as a variant.

### Pitfall 7: A guard test that reads `.planning/`
**What goes wrong:** the `features` suite becomes sensitive to planning-document layout.
**How to avoid:** the guard holds the classification as an inline literal map keyed by World file name, reads only `features/step-definitions/` (the `step-patterns.steps.test.ts` precedent reads only `../../step-definitions/`), and `07-WORLD-TABLE.md` is the human-readable copy generated from the same table. Assertions: the set of `*World.ts` file names equals the map keys exactly (a new World without a classification fails; a removed World fails); each `H` file's first lines still contain `Hand-wired on purpose`; each `S` file imports `./shared/EventCapture.ts` and contains no `Layer.effectDiscard(` + `authEvents.stream`; no `H` file imports the scaffold.

## Code Examples

### The surface probe, adapted to take its entry and tsconfig as arguments
```javascript
// Source: .planning/phases/02-split-testauth/02-01-PLAN.md:90-131 (verbatim) with two argv edits
// (entry = process.argv[2]; tsconfig path = path.join(root, process.argv[3])). Write it to a mktemp -d directory
// OUTSIDE the repo; run from the worktree root with TS_API_PATH=$PWD/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript
```
Measured output of this probe on `packages/server/src/Credentials.ts` at `HEAD d4556566`: 30 headings; sha256 `efbf9b94e28774245a5630cdc2f9b1f3a17ccfe5b810211176af9ac31a7a9a1d`.

### The Credentials facade (shape, not full text)
```typescript
// Source: the 30 exports of packages/server/src/Credentials.ts at d4556566 (see Q3 table)
// @awthaq/server — Credentials
// (the existing 15-line header comment, unchanged)
export {
  PrincipalResolver,
  PrincipalResolverLive,
  PrincipalResolverWithUserFactsLive,
} from "./internal/PrincipalResolver.ts";
export type { PrincipalResolverShape } from "./internal/PrincipalResolver.ts";
export {
  contribute,
  CredentialResolvers,
  CredentialResolversFrozen,
  CredentialResolversLive,
  DuplicateCredentialResolver,
} from "./internal/CredentialResolvers.ts";
export type {
  ClaimCarrier,
  CredentialResolverContribution,
  CredentialResolversShape,
} from "./internal/CredentialResolvers.ts";
export { fromRequest, machineTier, optionalTier, presented, tier, userTier } from "./internal/Presented.ts";
export type { Carrier, Presented, SessionCarrier, Source, Tier } from "./internal/Presented.ts";
export { make, principalFields } from "./internal/Resolution.ts";
export type { Resolved, Rotation, Scope } from "./internal/Resolution.ts";
export { collecting, httpScope } from "./internal/Scopes.ts";
```
Check: 3 + 1 + 5 + 3 + 6 + 5 + 2 + 3 + 2 = 30.

## State of the Art

| Old approach | Current approach | When changed | Impact |
|--------------|------------------|--------------|--------|
| Each World re-declares an `AuthEvents` subscriber | One helper | this phase (if taken) | 3 copies of the `startImmediately` race fix collapse to one |
| One 678-line `Credentials.ts` | A facade plus 5 internal modules | this phase | locality per concern; public surface unchanged |
| Hand-rolled World clock layers | `serve({ testClock })`, `lazyApp({ alignStepClock })` | plan 08 / plan 34 (already) | the "TestClock tail" the roadmap names is already one option |

**Deprecated/outdated:** the roadmap's wording "the shared tail (`lazyApp`, `TestClock`, capture layers)" for Phase 7 (superseded by the census above).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The generic `captureEvents` shape compiles as sketched under `exactOptionalPropertyTypes` and no-`as` (the two-branch stream unification may need two exports or an overload) | Q2 / Pattern 1 | Wave 0 compile probe fails; adjust the shape before any World edit; no World is touched until the helper and its pin compile |
| A2 | The three type-pin claims (1)-(3) compile or fail as sketched | Q2 | The pin is rewritten; the gate files still prove the base behaviour |
| A3 | A runtime-key pin test for `Credentials` is wanted (Phase 2 chose one for `TestAuth`) | Q3 | One fewer test file; the probe diff remains the proof |
| A4 | TS2883 does not trigger for the moved inferred-type consts | Q3 risks | `tsc -b` fails at the first extraction; fix by naming the type in the owning module (the documented exception) |
| A5 | The Postgres container recreate command shape (`pg-fresh.sh` is not in the repo) | Q4 | The planner uses the Phase 6 script if present locally; otherwise the inferred command |
| A6 | Phase 6 close numbers are still the right comparison after the review fixes | Q4 | Wave 0 re-records every gate; the plan compares against that, not these |
| A7 | The line savings (about -13 for the helper) | Q2 | Immaterial; the helper is kept for locality, not size, and the plan must say so |
| A8 | `OrganizationWorld`'s `subscribe` registration is observably different from `stream` + `startImmediately` | Pitfall 6 | If equivalent, Organization could be a 4th adopter; keep it out unless a Wave 0 probe proves equivalence on both backends |

## Open Questions

1. **Decisions for the orchestrator**
   - **(a) Scaffold scope.** The roadmap's SC1 says the scaffold "wrap[s] `TestAuth.layer`" and supplies "`lazyApp`, `TestClock`, capture layers". The measured facts: `lazyApp` and `TestClock` are already single calls/options of `TestAuth` (nothing repeated), only the events subscriber repeats (3 Worlds, plus a variant). Options: **(i) recommended**: small scaffold `captureEvents` for Admin, Password, Domain, plus the table and the guard, recorded as "smaller scaffold plus a table" per D-05; **(ii)** table and guard only, scaffold recorded not pursued (also D-05-compliant; WORLD-01's scaffold clause becomes "not pursued"); **(iii)** a literal wrapper around `TestAuth.layer`: not recommended (Pitfall 1). Needed before planning the C3 plans.
   - **(b) The exempt vocabulary.** The table has three classes (scaffolded 3, hand-wired 5, no-tail 23), not "scaffolded or exempt" with five exempt. ROADMAP SC1 ("every World as scaffolded or exempt") is satisfied if "exempt" covers both exempt classes; SC2's "five hand-wired exempt Worlds are untouched" is satisfied by the five; confirm that 23 further "exempt" Worlds is the intended reading and not a sign the phase should be re-scoped.
   - **(c) Organization as a 4th adopter** only with a `registration` option (a single honest parameter by D-05's own words, but then the helper has two code paths). Recommendation: no.
   - **(d) Guard test placement:** a new file in `features/features/_guard/` (bdd files 39 to 40) or a new case in the existing guard file (files stay 39). Recommendation: new file.
2. **Whether to commit `07-CRED-SURFACE-BEFORE.txt` and the runtime-key pin before the split.** Phase 2 did both (Wave 0, committed first). Recommendation: yes.
   - What we know: the probe is reproducible (sha above).
   - What is unclear: nothing technical.
3. **`features/STYLE.md` pointer.** One line under "World lifetime" (`STYLE.md:233-236`) naming the helper would keep the convention discoverable; optional.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| node | everything | yes | v26.13.0 | - |
| pnpm | gates | yes | 11.20.0 | - |
| TypeScript (tsgo) | `tsc -b` | yes | `7.0.2+effect-tsgo.0.67.4` | - |
| TypeScript 5.9.3 compiler API | the surface probe | yes | `node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/typescript.js` exists | - (a measuring instrument only; never added to a `package.json`) |
| Docker + Postgres 16 (`awthaq-p3-pg`, port 55433) | Postgres legs | yes | `pg_isready` accepting connections; `ShmSize` 1 GiB | record "not run" is superseded by CONTEXT D-08 |

**Missing dependencies with no fallback:** none. **With fallback:** none.

## Validation Architecture

`.planning/config.json` contains only `workflow.use_worktrees`; `workflow.nyquist_validation` is absent, so this section is enabled.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 5 (`@effect/vitest` in packages; `@effect-cucumber/vitest` ^0.10.1 for `features/`) |
| Config file | root `vitest.config.ts` (`projects: ["packages/*", "examples/..."]`), `features/vitest.config.ts` (`include: ["features/**/*.steps.test.ts"]`, `setupFiles: ["./step-definitions/shared/LeakGuard.ts"]`) |
| Quick run command (C8) | `npx tsc -b tsconfig.json && npx vitest run packages/server` |
| Quick run command (C3) | `npx tsc -b tsconfig.json && npx tsc -p tsconfig.test.json && npx vitest run --root features features/_guard` (or `pnpm test:bdd`, about 12 s) |
| Full suite command | `npx tsc -b tsconfig.json && pnpm test && pnpm test:bdd`, then the gate list in Q4 |

### Phase Requirements to Test Map
| Req ID | Behavior | Test type | Automated command | File exists? |
|--------|----------|-----------|-------------------|--------------|
| WORLD-01 | every World is classified; the classification is a committed table | guard + artifact | `pnpm test:bdd` (the guard case) and `test -f .planning/phases/07-.../07-WORLD-TABLE.md` with 31 data rows (`awk` over the table) | guard: Wave 0 |
| WORLD-01 | adopting Worlds lost their inline subscriber and import the helper | static | `grep -c 'authEvents.stream' features/step-definitions/{AdminWorld,PasswordWorld,DomainWorld}.ts` prints 0 each; `grep -c "shared/EventCapture" ...` prints 1 each | after C3 |
| WORLD-02 | the five hand-wired Worlds untouched | static | `git diff --name-only <base> HEAD -- features/step-definitions/{AuthenticationWorld,ContractStratumWorld,CsrfWorld,QadiBridgeWorld,TenancyWorld}.ts` prints nothing | command |
| WORLD-02 | no second host composer | static | `git diff --name-only <base> HEAD -- packages/test` prints nothing; `grep -rn "AuthHost.layer\|TestAuth.makeLayer" features/step-definitions/shared/EventCapture.ts` prints nothing | command |
| WORLD-02 | `LeakGuard` accounting unchanged | bdd | `pnpm test:bdd 2>&1 | grep '\[leak-guard\]' | sort` identical before and after (39 files, all `apps=0 sqlClients=0`) | command |
| WORLD-02 | omitting a plugin is still a compile error; the scaffold adds no requirement | type | `npx tsc -p tsconfig.test.json` and `npx tsc -b tsconfig.json` green with `EventCapture.types.ts` and the 4 existing gate files; plus the recorded mutation check | `EventCapture.types.ts`: Wave 0 |
| WORLD-02 / D-04 | same scenarios, same results | bdd | `pnpm test:bdd` and the Postgres leg: 1580 + guard delta passed, 44 skipped | command |
| CRED-01 | export-name and shape diff empty | probe | `diff 07-CRED-SURFACE-BEFORE.txt 07-CRED-SURFACE-AFTER.txt` prints nothing; 30 headings | BEFORE: Wave 0 |
| CRED-01 | runtime keys unchanged | unit | `npx vitest run packages/server/test/CredentialsSurface.test.ts` | Wave 0 |
| CRED-01 | behaviour unchanged | unit | `npx vitest run packages/server/test/Credentials.test.ts packages/server/test/Authentication.test.ts packages/server/test/CredentialResolvers.test.ts` (unedited) | yes |
| CRED-01 | consumers compile without edits | type + diff | `npx tsc -b tsconfig.json && npx tsc -p tsconfig.test.json`; `git diff --name-only <base> HEAD -- packages/api-key packages/jwt packages/qadi packages/web packages/test packages/next` prints nothing | command |
| CRED-01 | ADR-EA-042 untouched | static | `git diff --quiet <base> HEAD -- spec/decisions/042-credential-resolution-module.md` exits 0 | command |
| CRED-01 | no cycle, no knip row | gate | `pnpm circular`; filtered `pnpm knip` equals baseline | command |

### Sampling Rate
- **Per task commit:** the quick run for the touched side, plus `npx tsc -b tsconfig.json` (the first gate in every task, as GATE-01).
- **Per wave merge:** `pnpm test`, `pnpm test:bdd`, the leak-guard line diff, the probe diff (C8 waves).
- **Phase gate:** every gate in Q4 at or equal to the re-recorded Wave 0 baseline, both backends, plus the path allowlist and the empty-diff checks.

### Wave 0 Gaps
- [ ] `07-BASELINE.md`: every gate at the planning HEAD, on both backends; `git status --short` as found; the leak-guard line list; the 30-heading `07-CRED-SURFACE-BEFORE.txt` with its sha.
- [ ] `07-WORLD-TABLE.md` (the Q1 table, committed before any World edit) and the guard test, green against untouched Worlds, in one commit, not edited afterwards.
- [ ] `packages/server/test/CredentialsSurface.test.ts` (runtime-key pin), green against the untouched file.
- [ ] `features/step-definitions/shared/EventCapture.ts` plus `EventCapture.types.ts` compiled and green before any World adopts it (Wave 0 or Wave 1, but before the Worlds).
- Framework install: none.

## Security Domain

`security_enforcement` is not disabled in `.planning/config.json`, so this applies. The phase adds no input, endpoint or credential path: C3 is test-suite scaffolding; C8 is a behaviour-preserving move of security-sensitive code (credential precedence, tier admission, rotation hand-off), so the relevant control is "no behaviour change".

### Applicable ASVS Categories

| ASVS Category | Applies | Standard control |
|---------------|---------|-----------------|
| V2 Authentication | yes (the moved code resolves credentials) | unchanged code moved verbatim; `Credentials.test.ts` table (23 shapes x 3 tiers) and the served Path A parity table are the regression bar |
| V3 Session Management | yes (rotation hand-off, impersonation rule, single-flight verify) | the memo tables stay with `make` (Pitfall 4); `Authentication.test.ts` rotation cases |
| V4 Access Control | yes (tier admission: user tier admits `User` only) | `userTier`/`machineTier` declarations move verbatim |
| V5 Input Validation | yes (`bearerCredential` RFC 9110 parse, `nonEmpty`) | moved verbatim; the parsing tests are unedited |
| V6 Cryptography | no | none touched |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| A split duplicates a memo table, so a rotating `verify` runs twice or a claim is charged twice | Tampering / integrity | one module owns `sessionMemo`/`claimMemo`/`outages`/`once`/`make` (Pitfall 4); `grep -c "new WeakMap"` = 3 across `internal/`, all in `Resolution.ts` |
| A split exposes a private helper (`once`, `resolveClaimed`) as public API | Elevation / info disclosure | named re-exports only; probe diff empty |
| A moved credential carrier loses its `Redacted` wrapping | Information disclosure | verbatim move; no new logging; `grep -c "Redacted"` per file unchanged in total (record before/after) |
| A test-suite helper changes event-capture timing and hides a race the scenario was written to observe | Repudiation (a missed event is a missed audit) | `startImmediately` preserved; Postgres bdd leg runs the adopters under socket I/O |

## Sources

### Primary (HIGH confidence, read or executed this session)
- `.planning/phases/07-world-scaffold-and-credentials-split-optional/07-CONTEXT.md`; `.planning/ROADMAP.md` (Phase 7, lines 184-193), `.planning/REQUIREMENTS.md` (WORLD-01/02, CRED-01, lines 60-65)
- `.planning/phases/06-record-store-scaffolding/{06-RESEARCH,06-BASELINE,06-VERIFICATION,06-12-SUMMARY}.md` (layout, gate format, close numbers); `.planning/phases/02-split-testauth/{02-CONTEXT,02-01-PLAN,02-05-SUMMARY}.md` (probe, no-changeset precedent)
- `.planning/research/{ARCHITECTURE.md:133,330; FEATURES.md:105-141; PITFALLS.md:206-225; SUMMARY.md:22,153}` (the origin of "five hand-wired")
- `spec/decisions/042-credential-resolution-module.md` (read in full)
- `packages/server/src/Credentials.ts` (read in full, 678 lines), `packages/server/src/index.ts`, `packages/server/package.json`, `packages/server/tsconfig.src.json`, `tsconfig.base.json`, `knip.json`, `scripts/circular.mjs`
- `packages/test/src/internal/{composition.ts:80-296, appHarness.ts:100-424}` (the `layer` overloads, `serve`, `lazyApp`), `packages/test/test/TestAuthRecords.types.test.ts`
- `features/step-definitions/shared/{Harness,LeakGuard,FirstPartyComposition}.ts`, `features/step-definitions/{AdminWorld,PasswordWorld,OrganizationWorld,DomainWorld,SamlWorld,SessionWorld,DeviceAuthorizationWorld,MagicLinkWorld,PasskeyWorld,JwtWorld,ScimWorld,CliWorld,CrossCuttingApp,PluginTypeGates,CompileTimeGates}.ts` and the headers/greps of the other World files; `features/{STYLE.md,package.json,tsconfig.json,vitest.config.ts}`, `features/features/_guard/step-patterns.steps.test.ts`
- Executed: surface probe on `Credentials.ts` (sha above); `git diff`, `docker exec ... pg_isready`, `node/pnpm/tsc` version probes, per-World `grep -c` census, `grep -rl` of `Credentials` importers

### Secondary (MEDIUM confidence)
- Phase 6 close numbers (read from `06-12-SUMMARY.md` and `06-VERIFICATION.md`, not re-run here)

### Tertiary (LOW confidence)
- None beyond the `[ASSUMED]` items in the Assumptions Log

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - nothing installed; every tool already in the repo
- World census: HIGH - per-file greps plus reads of every adopting World's region; the three classes are mutually exclusive and sum to 31
- Scaffold design and type pin: MEDIUM - read from the code but not compiled (A1, A2)
- Credentials anatomy, graph and proof method: HIGH - full read, probe executed, importers enumerated
- Baseline numbers: MEDIUM - Phase 6 close figures; must be re-recorded (A6)
- Pitfalls: HIGH for 2-5 (mechanical, tied to `verbatimModuleSyntax`, `scripts/circular.mjs`, knip config), MEDIUM for 1 and 6 (design judgement)

**Research date:** 2026-11-15
**Valid until:** 2026-11-22 (the tree is quiet between phases; re-check `git diff --name-only d4556566 HEAD -- packages features` before planning)
