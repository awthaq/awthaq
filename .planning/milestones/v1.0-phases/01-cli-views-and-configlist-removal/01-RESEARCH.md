# Phase 1: CLI views and ConfigList removal - Research

**Researched:** 2026-11-14
**Domain:** Brownfield TypeScript/Effect (effect@4.1.2) CLI refactor in `packages/cli`; output-format resolution, a package-export removal, spec and changeset bookkeeping, gate baseline
**Confidence:** HIGH (every claim below was read from the repo or measured by running the gate this session; no external libraries are added, so no web research was needed)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Output behaviour (preserve exactly)**
- Today's precedence is the contract: on the graph view `--format dot` beats `--json`; `--format json` and `--json` both produce the JSON document for every view; hooks, rules and events have no dot branch; text is the fallback. A mode x (text, `--format json`, `--json`, dot) matrix over all views is written first and passes against the pre-refactor code. - **Reversibility:** costly - CLI output is consumed by scripts, and BEH-EA-225 (`--json` failure documents) pins the global flag.
- Failure rendering stays on the global `--json` only: `--format json` does not change how failures are rendered. Making `--format json` imply `--json` globally would change observable failure output, so it is not done. - **Reversibility:** costly - changes the stderr failure contract of BEH-EA-225.

**ConfigList removal**
- `ConfigList` is removed from the package export and the tree (CLI-03). The `config list` command keeps its output byte-for-byte. The released-surface change is announced by a changeset with a `Migration:` line, and `spec/behaviors/26-cli.md` (citations at lines 46 and 398, BEH-EA-202/225/229) is updated with Revision and Change History bumped together. - **Reversibility:** costly - a public barrel export disappears (the package is unpublished, so no external consumer is broken).

**Decided autonomously**
- [Views module] "Where does the views module live?" -> A new file `packages/cli/src/PluginViews.ts`, re-exported through the existing `Plugin` namespace only if tests need it.
- [Views module] "Shape: one function per view or a table keyed by selector?" -> One internal view descriptor (rows builder + text renderer + dot capability) per view, and a single `render` that selects by the options.
- [Views module] "Where is format resolved?" -> One function that maps (`--format`, `out.json`) to `text | json | dot` once per command, private to the module.
- [Output seam] "How does the views module reach `Output.report`?" -> Extend `Output.report` with an optional explicit-format override rather than re-implementing the branch, and keep its current behaviour when the option is absent (additive optional parameter, callers unaffected).
- [Output seam] "Which of `Migration.apply` and `Openapi` move onto `Output.report`?" -> Only the call sites whose captured stdout, stderr and documents stay identical under the existing tests; the rest are left and the reason is recorded in the plan summary.
- [ConfigList] "Where do the three lines of `ConfigList.show` land?" -> Inline into the `config list` command handler in `Cli.ts`; `Doctor.configContext` and `Doctor.descriptorsOf` lose their export if nothing else uses them (knip decides).
- [ConfigList] "Changeset bump level for the removed export?" -> minor, following the `test-app-removed` precedent (the project is unpublished, so no 1.0).
- [Tests] "Where does the matrix live and how are outputs asserted?" -> `packages/cli/test/PluginViews.test.ts` on `Output.capture`, asserting stdout lines and documents against inline expected values, committed green before the refactor.
- [Tests] "What happens to the existing `Doctor.test.ts` use of `ConfigList.show`?" -> It calls the inlined entry point through the same `Output.capture` layer; the assertion is unchanged (see Pitfall 5: the inlined handler is not directly callable; the recommended route is `runCli`).
- [Gates] "How is the knip baseline recorded?" -> A committed `.planning/phases/01-.../01-BASELINE.md` with the raw `pnpm knip` output (3 unlisted deps in `packages/sql/test/fixtures/readme-quickstart.ts`, `.reports/`, untracked `.claude/`) captured before any code change, and later phases compare against it.

### Claude's Discretion
Internal naming of the views module's exports, the exact test-case table layout, and the wording of the changeset and spec Change History entries.

### Deferred Ideas (OUT OF SCOPE)
None - discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CLI-01 | Every `plugin` view renders through one views module that resolves `--format` and `--json` once; output identical | Current precedence table (Architecture Patterns), exact current outputs (Current Output Record), views module shape and the cycle-free layout |
| CLI-02 | Mode x (text, `--format json`, `--json`, dot) matrix pins current output before the refactor | Recorded outputs for hookedApp and passwordAndRoles, the existing-coverage gap list, the matrix layout (Validation Architecture) |
| CLI-03 | `ConfigList` removed from export, inlined; changeset with `Migration:`; `26-cli.md` lines 46, 398 updated, Revision bumped | Full reference inventory of `ConfigList`, spec Revision/Change History mechanics (drift check 14), changeset precedent files |
| CLI-04 | `Migration.apply` and `Openapi` use the same `Output` seam where it costs no behaviour change | Per-call-site analysis (Architecture Patterns, "Seam adoption verdicts") |
| GATE-01 | All gates pass against the recorded baseline at phase close | Measured baseline results and timings for every gate (Environment Availability / Validation Architecture) |
| GATE-02 | knip baseline recorded before any code change | Raw knip result captured this session (140 unused files, 3 unlisted deps, exit 1); 01-BASELINE.md recipe |
| GATE-03 | One changeset per candidate with `Migration:` line; spec Revision and Change History bumped together | Changeset precedents (`cli-link-errors`, `test-app-removed`), check 14 mechanics |
</phase_requirements>

## Summary

The whole phase is a small, local refactor in `packages/cli`. `Plugin.show` (`packages/cli/src/Plugin.ts:254-288`) holds four copies of the `options.format === "json" || out.json` branch, plus a dot branch only on the graph/default path. `Output.report` (`Output.ts:80-85`) reads only `out.json`, which is why a naive swap to `report` would silently stop `--hooks --format json` from printing JSON (Pitfall 19). The fix is to give `Output.report` an optional explicit-json override, resolve the format once in a new `PluginViews.ts`, and keep `Plugin.show` and its signature so the existing `Inspection.test.ts` and the new matrix run unchanged before and after.

`ConfigList` is 28 lines; its only consumers are `Cli.ts:40,152`, `index.ts:12`, `Doctor.test.ts:24,237`, and prose citations in `spec/behaviors/26-cli.md` lines 46 and 398. No other package imports it. `Doctor.configContext` and `Doctor.descriptorsOf` are used inside `Doctor.ts` (lines 226, 248) and will be used from the inlined `Cli.ts` handler, so they keep their exports; knip will not ask for removal.

The gate baseline is already measured (all green except knip, which fails pre-existing on 140 untracked `.claude/` and `.reports/` files plus 3 unlisted deps in the sql fixture). Total wall time for the full gate set is about 9 minutes; `pnpm spec:verify:strict` (97 s), `pnpm test` (125 s) and `pnpm knip` (107 s) dominate.

**Primary recommendation:** Wave 0 = write `01-BASELINE.md` and `packages/cli/test/PluginViews.test.ts` (matrix, green against untouched code, committed alone). Then add `PluginViews.ts` as a *generic* resolve-and-render helper that `Plugin.ts` imports (no cycle, `Plugin.show` stays public), extend `Output.report` with `{ json?: boolean }`, inline `ConfigList` into `Cli.ts` using `runCli` in `Doctor.test.ts`, move `Openapi` stdout onto `Output.report`, and ship one `@awthaq/cli: minor` changeset plus the `26-cli.md` 1.9 -> 1.10 bump.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Format resolution (`--format` x `--json`) | CLI command layer (`Plugin`/`PluginViews`) | `Output` service | The `--format` flag is per-command; `Output` only knows the global `--json`. Resolve once at the command, hand `Output` an explicit override |
| Failure rendering | `Output.failure` (global `--json`) | `Cli.run` | Locked: stays on the global flag only (BEH-EA-225) |
| Manifest row building (graph/hooks/rules/events) | `Plugin.ts` pure functions | - | Manifest-only (BEH-EA-208 class 1); no Layer built |
| `config list` rendering | `Cli.ts` handler | `Doctor.configContext`/`descriptorsOf`, core `EffectiveConfig` | Three lines of glue; no module needed |
| Package surface | `index.ts` barrel | `.changeset/` | A removed export is announced by a changeset with `Migration:` |

No browser/CDN/database tiers are involved.

## Standard Stack

### Core
No new libraries. Everything uses what `packages/cli` already depends on.

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| effect | catalog (4.1.2) | `Effect.gen`, `Context.Service` (`Output`), `Ref`, `Console` | Already the substrate; `Output` is a `Context.Service` |
| @effect/vitest | catalog | `it.effect`, `assert`, `describe` | Every cli test uses it (`Inspection.test.ts:6`) |
| vitest | 5.0.2 (observed `RUN v5.0.2`) | runner; root config uses `projects: ["packages/*", ...]` | `vitest.config.ts` |

### Supporting
None.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Optional `{ json }` arg on `Output.report` | A second helper `Output.reportAs` | More surface for no gain; locked decision is the optional parameter |

**Installation:** none. **Version verification:** not applicable (no packages added; REQUIREMENTS.md "Out of Scope: New dependencies or version bumps").

## Package Legitimacy Audit

No external packages are installed by this phase. Audit not applicable. Packages removed due to SLOP: none. Packages flagged SUS: none.

## Architecture Patterns

### Current precedence (the contract, verified by reading `Plugin.ts:254-288` and by running every cell)

```
selector precedence (first true wins):  --hooks  >  --rules  >  --events  >  graph/default
```
Verified by running the real argv: `plugin list --hooks --rules` printed the hooks view; `plugin list --rules --events` printed the rules view.

| View | text (default) | `--format json` | `--json` (global) | `--format dot` | `--format dot` + `--json` |
|------|---------------|-----------------|-------------------|----------------|---------------------------|
| default (no view flag) | lines `N. id` | one document (the graph nodes) | one document | dot lines | dot lines, 0 documents |
| `--graph` | `renderText` lines | one document | one document | dot lines | dot lines, 0 documents |
| `--hooks` | `renderHooks` lines | one document | one document | **text** (same as text) | **json document** |
| `--rules` | `renderRules` lines | one document | one document | **text** | **json document** |
| `--events` | `renderEvents` lines | one document | one document | **text** | **json document** |
| `--format json` + `--json` | same as json (one document, not two) in every row | | | | |

So the resolver is exactly:
```
dotCapable (graph/default only) && format === "dot"  -> "dot"
format === "json" || out.json                         -> "json"
otherwise                                             -> "text"
```
Note `--graph` changes only the text rendering (graph vs bare ids); JSON and dot of the default view and of `--graph` are identical.

### System Architecture Diagram

```
argv ──> Cli.ts pluginList handler ──> load config ──> Plugin.show(auth, {graph,hooks,rules,events,format})
                                                            │ selector: hooks > rules > events > graph/default
                                                            ▼
                                       view descriptor { rows(auth), text(rows), dot?(rows) }
                                                            │
                                  PluginViews.render(view, auth, format)   <- the ONE place that reads
                                                            │                 options.format and out.json
                                       resolve: dot? -> "dot" ; format==="json"||out.json -> "json" ; else "text"
                                                            │
                                                            ▼
                         Output.report(rows, render, { json })   (json=true -> out.document(rows); false -> lines via render)
                                                            │
                                                            ▼
                                 Output service (layerConsole in the process, capture() in tests)
Failures: Cli.run -> Output.failure -> out.json only (UNCHANGED by this phase)
```

### Recommended structure (avoids a madge cycle)

`pnpm circular` counts type-only imports too (`scripts/circular.mjs` header). If `PluginViews.ts` imports row builders from `Plugin.ts` and `Plugin.show` imports `PluginViews.ts`, that is a type-inclusive cycle. Two cycle-free layouts:

1. **Recommended: `PluginViews.ts` is generic; `Plugin.ts` imports it.** `PluginViews.ts` exports the `Format` type, a private `resolve`, and `render(view, rows)`; it imports only `Output.ts`. `Plugin.ts` keeps `graph/hooks/rules/events`, the renderers, `describeTenancy`, declares four view descriptors, and keeps `show` as the dispatch (`hooks > rules > events > graph`). `Plugin.show`'s signature and `Plugin.Format` stay public, so `Inspection.test.ts` and the new matrix run unchanged across the refactor, and the barrel surface does not change.
2. Alternative: `Plugin.ts` stays pure data + renderers, `PluginViews.ts` owns `show`, `Cli.ts` calls `PluginViews.show`. This removes `Plugin.show` from the public surface (a breaking removal that needs its own `Migration:` text) and forces rewriting `Inspection.test.ts` call sites. Not recommended.

```
packages/cli/src/
├── Output.ts        # report gains optional { json?: boolean }
├── PluginViews.ts   # NEW: Format, resolve (private), render(view, rows) - imports Output only
├── Plugin.ts        # builders, renderers, 4 descriptors, show (delegates to PluginViews.render)
├── Cli.ts           # inlined `config list`; drops ConfigList import
├── Openapi.ts       # stdout through Output.report
└── (ConfigList.ts deleted)
```

### Pattern: explicit override on `Output.report` (additive)

Current code, verbatim (`packages/cli/src/Output.ts:80-85`):
```typescript
export const report = <A>(value: A, render: (value: A) => ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const out = yield* Output;
    if (out.json) return yield* out.document(value);
    yield* Effect.forEach(render(value), out.line, { discard: true });
  });
```
Shape to aim for (no return-type annotation, no `as`, per IMPLEMENTING.md):
```typescript
export const report = <A>(
  value: A,
  render: (value: A) => ReadonlyArray<string>,
  options?: { readonly json?: boolean },
) =>
  Effect.gen(function* () {
    const out = yield* Output;
    if (options?.json ?? out.json) return yield* out.document(value);
    yield* Effect.forEach(render(value), out.line, { discard: true });
  });
```
All existing callers (`Doctor.finish`, `Migration.status`, `Routes`, the inlined config list) omit the option and keep behaviour. `Output.failure` is untouched.

A `PluginViews.render` sketch: resolve to `"text" | "json" | "dot"`, then `report(rows, text, { json: false })` for text, `report(rows, dot, { json: false })` for dot, `report(rows, text, { json: true })` for json. Dot goes through `report` with `json: false` so even `--json` does not turn it into a document (this is the "dot beats json" rule, expressed once). A view with no `dot` renderer treats `"dot"` as non-dot (falls to the json/text test), which reproduces "hooks/rules/events have no dot branch".

### Seam adoption verdicts (CLI-04, per call site)

| Call site | Verdict | Reason |
|-----------|---------|--------|
| `Openapi.emit` stdout (`Openapi.ts:34`, `out.line(text)`) | **Move** to `Output.report(spec, () => [text])` | Text mode: one line, identical. `--json` mode: `out.document(spec)` prints `JSON.stringify(spec, null, 2)`, which is the same bytes as `text` (`Output.ts` `stringify`). Only observable delta: under `Output.capture(true)` the `documents` ref gains one entry (no test reads openapi documents; existing test uses text mode). Pin with a test written first. The `--out <file>` branch (writes `text + "\n"`) is untouched |
| `Migration.apply` `finish` (`Migration.ts:87-88`) | **Optional, behaviour-identical**: `Output.report({ pending, drift, applied }, () => [])` | Text: empty render prints nothing (same as `Effect.void`); json: one document. `Migration.test.ts:155` pins one document with keys `pending, drift, applied`. Low value (the `out` handle is still needed for the two `!out.json` guards at lines 89 and 117); planner may leave it and record why |
| `Migration.apply` text status lines (`:89`) and `applied N migration(s)` (`:117`) | **Leave** | They are text-only and emitted at different points than the document (status before the drift/plan checks, "applied" after the write); `report` couples text and document at one point, so merging would reorder output |
| `Migration.status` | already uses `Output.report` (`:64`) | nothing to do |

### Anti-Patterns to Avoid
- **Replacing the branches with bare `Output.report` and no override:** drops `--hooks --format json` (Pitfall 19).
- **Making `--format json` imply global `--json`:** changes failure rendering (locked decision).
- **`PluginViews.ts` importing `Plugin.ts` while `Plugin.ts` imports it back:** `pnpm circular` fails.
- **Putting `renderText` of config items in a module named like another:** `Doctor.ts` already exports `renderText` (`Doctor.ts`, report renderer); name the inlined one distinctly (for example `renderConfigItems`) if it stays a top-level const in `Cli.ts`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON vs lines printing | A new emit helper | `Output.report` with the optional override | One seam; failure and document paths already exist |
| Test output capture | A fake console | `Output.capture(json)` (stdout, stderr, documents refs) and `runCli(args, config)` for real argv | Already used by `Inspection.test.ts`, `Migration.test.ts`, `Doctor.test.ts` |
| Spec revision check | Manual diffing | `pnpm spec:verify:strict` check 14 | It compares Revision to the newest Change History row |
| Changeset authoring | Hand-tuned release notes | A plain `.changeset/<name>.md` modelled on `cli-link-errors.md` | The fixed group handles versioning |

## Runtime State Inventory

Not a rename/migration phase in the data sense (an export removal and a code refactor). Explicit answers for completeness:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None - the CLI stores nothing under the name `ConfigList` | none |
| Live service config | None - verified: no external config references `ConfigList` | none |
| OS-registered state | None | none |
| Secrets/env vars | None | none |
| Build artifacts | `packages/cli/lib/` (git-ignored: `git check-ignore packages/cli/lib` printed the path) holds built `ConfigList.js/.d.ts` and `Doctor.d.ts`. Stale after the delete | run `pnpm clean` then `pnpm build` (or `tsc -b`) before `pnpm package:smoke`, so smoke does not see a stale file; do not commit `lib/` |

## Common Pitfalls

### Pitfall 1: dot beats json only where dot exists
**What goes wrong:** A single resolver that returns `"dot"` for any view prints dot for `--hooks --format dot`, but today it prints text (and with `--json`, a document).
**How to avoid:** Resolver takes a `dotCapable` flag per view descriptor. The matrix rows `hooks/dot`, `hooks/dot+json` (and rules, events) pin it.

### Pitfall 2: two documents under `--format json --json`
**What goes wrong:** Resolving json from both flags then calling `out.document` once per flag.
**How to avoid:** Resolve once; matrix cell `formatjson+json` asserts `documents.length === 1`.

### Pitfall 3: `--json` stdout shape through `Output.capture`
`capture.document` pushes the document to the `documents` ref **and** pushes `JSON.stringify(value, null, 2)` as one stdout entry (`Output.ts` capture). Matrix assertions should check both: `documents.length`, `deepStrictEqual(documents[0], rows)`, and `stdout.length === 1`.

### Pitfall 4: type-inclusive import cycle
See Recommended structure. `pnpm circular` runs a second pass counting `import type`.

### Pitfall 5: the inlined `config list` handler is not directly callable
The decision text says `Doctor.test.ts` "calls the inlined entry point through the same `Output.capture` layer". But a handler inlined into `Command.make("list", {}, () => ...)` has no callable name. Options: (a) `runCli(["config", "list"], config)` from `test/support/RunCli.ts` and join `stdout` (zero new exports; I ran `config list` and `--json config list` this way and got 18 stdout entries and a JSON document, so it works); (b) export a small named Effect from `Cli.ts`. Recommend (a): the assertions at `Doctor.test.ts:238-243` (`include`/`notInclude` on the joined text) are unchanged.

### Pitfall 6: spec prose is not covered by drift checks
Pitfall 20: check 10 scans only `invariants.md` and `traceability.md`, so a stale `ConfigList.ts` citation in `26-cli.md` does not fail `spec:verify:strict`. Verify by `grep -rn "ConfigList" spec packages docs examples features` returning nothing at phase close (only `.planning/` may mention it).

### Pitfall 7: knip cannot see prose or the barrel
`knip.json` sets `ignoreExportsUsedInFile: true` for `packages/cli` and the barrel export is an entry, so after removing `export * as ConfigList` the file must be deleted by hand; knip would flag it as an unused file only if it were left (it is). Do not rely on knip to find the spec citations.

### Pitfall 8: `tsc -b` does not typecheck tests
`tsc -b tsconfig.json` (GATE-01) skips test files; `tsc -p tsconfig.test.json` is what typechecks `PluginViews.test.ts` and `Doctor.test.ts`. Run both (`pnpm typecheck` does). Both exit 0 on the baseline.

### Pitfall 9: formatting and lint on new files
`pnpm lint` (oxlint) and `pnpm format:check` (oxfmt) both pass at baseline; run `npx oxfmt <new paths>` on the new test, `PluginViews.ts` and the changeset.

## Code Examples

### Existing test idiom (copy for the matrix) - `packages/cli/test/Inspection.test.ts:16-21` (verbatim)
```typescript
const captureStdout = <A, E>(effect: Effect.Effect<A, E, Output.Output>, json = false) =>
  Effect.gen(function* () {
    const { captured, layer } = yield* Output.capture(json);
    yield* effect.pipe(Effect.provide(layer));
    return yield* Ref.get(captured.stdout);
  });
```
The matrix needs all three refs (`stdout`, `stderr`, `documents`), so use the `Output.capture(json)` + `Plugin.show(app, {...}).pipe(Effect.provide(layer))` form from `Inspection.test.ts:101-105`.

### Real-argv idiom - `test/support/RunCli.ts` `runCli(args, config?)` returns `{ code, stdout, stderr, exit }`
```typescript
const r = yield* runCli(["--json", "plugin", "list", "--hooks"], configOf(hookedApp));
// r.code === 0, r.stdout.length === 1 (a JSON document), r.stderr == []
```
`configOf(auth, extra?)` is in `test/support/TestApp.ts`; fixtures: `hookedApp` (`test/support/HookedApp.ts`, plugins `alpha`, `beta`) and `passwordAndRoles` (`Auth.make([Password.Password, Roles.Roles])`).

### Changeset shape - precedent `.changeset/cli-link-errors.md` (from commit `1cef4beb`) and `test-app-removed.md` (commit `e55def53`)
```markdown
---
"@awthaq/cli": minor
---

`ConfigList` is no longer exported from `@awthaq/cli`; `awthaq config list` prints exactly what it printed. `awthaq plugin list` renders every view through one module that resolves `--format` and `--json` once, with unchanged output. (BEH-EA-202, BEH-EA-229)

Migration: replace `ConfigList.show(config)` with running `awthaq config list` (or, in code, `EffectiveConfig.read(yield* Doctor.configContext(config), Doctor.descriptorsOf(config))` rendered through `Output.report`); `ConfigList.renderText` has no replacement.
```
(Wording is Claude's discretion; the `Migration:` line is mandatory per `CONTRIBUTING.md` lines 95-104. `.changeset/config.json` has the `@awthaq/*` packages in one `fixed` group, so one `"@awthaq/cli": minor` entry is enough, as `cli-link-errors` shows.)

## Current Output Record (pre-refactor, measured this session)

Measured by a throwaway test (created and deleted; tree unchanged) calling `Plugin.show(app, {..., format})` under `Output.capture(json)` for every view and mode on both fixtures, plus the real argv through `runCli`.

**`hookedApp` (plugins `alpha`, `beta`; beta depends on alpha):**

default text (stdout, 2 lines): `1. alpha`, `2. beta`.

`--graph` text (stdout, 15 lines):
```
1. alpha
     depends on: -
     groups:     alpha
     tables:     -
     ports:      awthaq/ports/Mailer, awthaq/ports/RateLimiter
     exposes:    awthaq/plugin/alpha/Lamp
     hook taps:  cli.test.normalize #1 (order 5)
2. beta
     depends on: alpha
     groups:     beta
     tables:     -
     ports:      -
     exposes:    -
     hook taps:  cli.test.normalize #2 (order 0)
(ports and taps are the plugins' static declarations; application taps registered in the host run after every declared tap)
```
dot (default and `--graph`, with or without `--json`; 5 stdout lines, 0 documents): `digraph awthaq {`, `  "alpha";`, `  "beta";`, `  "alpha" -> "beta";`, `}`.

`--hooks` text (4 lines): `cli.test.normalize`, `  1. alpha (order 5)`, `  2. beta (order 0)`, `(application taps registered in the host run after every entry listed here)`. With `--format dot` and no `--json`: identical to text. With `--format dot --json`: the JSON document. JSON document: `[{"point":"cli.test.normalize","taps":[{"position":1,"plugin":"alpha","order":5},{"position":2,"plugin":"beta","order":0}]}]` pretty-printed with 2 spaces as ONE stdout entry, 1 document.

`--rules` text: one line `no installed plugin declares a rate-limit rule`; JSON: `[]` (1 document, stdout entry `"[]"`).

`--events` text (25 lines, header + 24 core events): header `TAG                             OWNER  ACTOR              PII  ATTEMPT`, first row `auth.token.replay               core   -                  -    yes`, last row `auth.mail.failed                core   userId             -    no`. The last column is not padded. Same under dot (no `--json`). JSON: array of `{tag, owner, actor, pii, attempt}`.

**`passwordAndRoles`:**
- default text: `1. password`, `2. roles`; default dot: `digraph awthaq {`, `  "password";`, `  "roles";`, `}` (no edges).
- `--graph` text first rows: `1. password` / `     depends on: -` / `     groups:     password, password.account` / `     tables:     -` / `     ports:      awthaq/ports/Mailer, awthaq/ports/PasswordHasher, awthaq/ports/RateLimiter, awthaq/ports/SqlTransaction` / `     exposes:    awthaq/plugin/password/Credential` / `     hook taps:  -` / `2. roles` / ... `     tables:     roles_assignments (global: global roles, ADR-EA-025)`. 16 lines total.
- `--hooks` text: the single line `no installed plugin declares a hook tap (application taps are registered when the app runs)`; JSON `[]`.
- `--rules` text: 19 lines (header + 18 rules), header `PLUGIN    RULE                    ENDPOINT                         DIMENSION  KEY         MODE      LIMIT`, first rule `password  signUp                  password.signUp                  identity   email       attempts  5 per 1h`, `signIn` row `password  signIn                  password.signIn                  identity   email       attempts  5 per 15m`.
- `--events` text: 31 lines.

**Real argv through `runCli` (hookedApp config):**
| argv | exit | stdout | stderr |
|------|------|--------|--------|
| `plugin list` | 0 | `1. alpha`, `2. beta` | none |
| `--json plugin list --hooks` | 0 | 1 entry (JSON doc) | none |
| `plugin list --hooks --format json` | 0 | 1 entry (JSON doc) | none |
| `plugin list --graph --format dot --json` | 0 | 5 dot lines | none |
| `plugin list --hooks --rules` | 0 | the hooks text (4 lines) | none |
| `plugin list --rules --events` | 0 | the rules text (1 line) | none |
| `config list` | 0 | 18 text lines, first `core  awthaq/core/SessionConfig  (default)` | none |
| `--json config list` | 0 | 1 JSON doc (array of items with `owner`, `key`, `scope`, `source`, `entries`) | none |
| `openapi` and `--json openapi` | 0 | 1 entry each: the pretty-printed document starting `{\n  "openapi": "3.1.0",` | none |

### What `Inspection.test.ts` already pins vs the gaps the matrix must close
Already pinned (read in full): graph text with `format: "text"`, graph dot first/last lines, graph/hooks/rules/events `--format json` document equality against the builders, hooks/rules empty text, hooks text lines. **Not pinned anywhere:** the default view (no `--graph`) in any mode; any case with `out.json === true` on `Plugin.show` (the `--json` column); any dot case on hooks/rules/events; dot + `--json` precedence; selector precedence (hooks > rules > events); `--format json` + `--json` giving one document; stdout entry shape under json; the `openapi --json` parity; `config list` byte parity under `--json`. The matrix file below is exactly these gaps plus a whole-grid golden for `hookedApp`.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Four hand-copied json/text branches in `Plugin.show` | One resolver + `Output.report` override | this phase | A fifth view can no longer miss the `--format` check |
| `ConfigList` module with a public export | Inline in `Cli.ts` | this phase | One less public surface; spec citations move |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Next spec Revision after 1.9 is `1.10` (numeric compare in drift check 14 handles it: `cmp` splits on "." and compares as Number, regex `\d+\.\d+`) rather than `2.0`. No spec in `spec/behaviors/` has a minor >= 10 yet (grep found none), so there is no in-repo precedent for the spelling | Spec bookkeeping | Low: either passes check 14; user may prefer `2.0`. `[ASSUMED]` for the spelling; the check mechanics are `[VERIFIED: spec/scripts/check-drift.mjs:203-224]` |
| A2 | Today's date `2026-11-14` for the Change History row's date | Spec bookkeeping | Cosmetic |
| A3 | Bump level `minor` for `@awthaq/cli` | Changeset | Locked by CONTEXT.md (decided autonomously) |
| A4 | The spec lines to edit are 46, 70 and 398 (line 70 cites `Plugin.ts` as BEH-EA-202's implementation and should also name `PluginViews.ts` and `test/PluginViews.test.ts`); line 70 is not named in the roadmap but cites the code being changed | Spec bookkeeping | Low: if line 70 is skipped, no gate fails, but the citation is incomplete |

## Open Questions

1. **Should `Migration.apply`'s `finish` move onto `Output.report(..., () => [])`?**
   - Known: behaviour-identical and pinned by `Migration.test.ts:155`; `Migration.postgres.test.ts` is not run locally (no Postgres).
   - Unclear: reviewers may find `() => []` contorted for a single call site.
   - Recommendation: do `Openapi`; leave `Migration.apply` and record "text lines and document are emitted at different points; `report` couples them" in the plan summary. Doing the `finish` swap is acceptable but not required for CLI-04's "where it costs no behaviour change".
2. **Does the matrix need `runCli` cells or only `Plugin.show` cells?**
   - Recommendation: both. `Plugin.show` cells prove the resolver; a handful of `runCli` cells (`--json plugin list --hooks`, `--hooks --format json`, `--graph --format dot --json`, `--hooks --rules`) prove the flag parsing and that `Cli.ts` wires `format` through, which a `show`-level test cannot.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| node | everything | yes | v26.13.0 (repo requires >=22.12.0) | - |
| pnpm | gate scripts | yes | 11.20.0 | - |
| vitest | tests | yes | 5.0.2 | - |
| knip | GATE-02 | yes | via `pnpm knip` (107 s) | - |
| Postgres / docker | `Migration.postgres.test.ts` | not needed for this phase | `AWTHAQ_POSTGRES_URL` unset | the file is skipped locally (1 skipped test file); no SQL is touched in Phase 1 |

**Missing dependencies with no fallback:** none.

## Validation Architecture

(`.planning/config.json` does not exist, so `workflow.nyquist_validation` is treated as enabled.)

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 5.0.2 with `@effect/vitest` (`it.effect`, `assert`) |
| Config file | root `vitest.config.ts` (`projects: ["packages/*", ...]`), `packages/cli/vitest.config.ts` (`name: "cli"`, `include: ["test/**/*.test.ts"]`) |
| Quick run command | `npx vitest run --project cli packages/cli/test/PluginViews.test.ts` (about 4-5 s) |
| Full cli project | `npx vitest run --project cli` (measured: 10 files passed, 1 skipped; 130 tests passed, 1 skipped; 2.7 s) |
| Full suite command | `pnpm test` (2 m 05 s) |

### Gate baseline (measured this session, before any code change)

| Gate | Command | Result | Wall time |
|------|---------|--------|-----------|
| tsc -b | `npx tsc -b tsconfig.json` | exit 0 | 4.9 s |
| tests typecheck | `npx tsc -p tsconfig.test.json` | exit 0 | 6.4 s |
| unit | `pnpm test` | exit 0; 409 files passed, 4 skipped; 6390 tests passed, 1 expected fail, 15 skipped | 2 m 05 s |
| bdd | `pnpm test:bdd` | exit 0; 39 files passed; 1576 tests passed, 44 skipped | 20.6 s |
| circular | `pnpm circular` | exit 0 | 3.3 s |
| spec | `pnpm spec:verify:strict` | exit 0; PASS 32, FAIL 0, SKIP 0 | 1 m 38 s |
| error tags | `pnpm check:error-tags` | exit 0; `163 internal and 137 wire error tags, none shared` | 0.5 s |
| transactions | `pnpm check:transactions` | exit 0; `no bare sql.withTransaction in packages/*/src` | 0.5 s |
| coverage | `pnpm coverage` | exit 0; All files 91.61 stmts / 85.08 branches / 86.8 funcs / 92.14 lines (floors 89/83/84/90) | 1 m 23 s |
| knip | `pnpm knip` | **exit 1 (pre-existing)**: `Unused files (140)` = 4 under `.claude/gsd-core`, 25 `.claude/hooks`, 10 `.claude/scripts`, 101 under `.reports/`; `Unlisted dependencies (3)`: `@awthaq/core`, `@awthaq/password`, `@awthaq/server` all at `packages/sql/test/fixtures/readme-quickstart.ts` (lines 2:10, 11:10, 12:10). No unused exports, no unused dependencies | 1 m 47 s |
| lint | `pnpm lint` | exit 0 | 1.5 s |
| format | `pnpm format:check` | exit 0 (1203 files) | 0.5 s |
| readmes | `pnpm check:readmes` | exit 0 | 0.5 s |
| package smoke | `pnpm package:smoke` | exit 0 | 41 s |
| workspace | `pnpm workspace:check` | exit 0 | 0.5 s |

Quirk to record in `01-BASELINE.md`: during this research run `knip.json` appeared modified in the working tree (an added `ignoreIssues` entry for the sql fixture's `unlisted`) and was reverted again a few minutes later. I did not make that edit. The knip run reported above used the committed `knip.json`. The baseline file should state `git diff --stat knip.json` (empty) at capture time, and the phase-close comparison must also show it unchanged (STATE.md: "record it, do not 'fix' it").

Baseline rule for knip at phase close: the output must equal the baseline (same 140 unused files, same 3 unlisted lines) and add no new line. Concretely, `pnpm knip 2>&1 | grep -v '^\.claude/\|^\.reports/'` must show only the three `Unlisted dependencies` rows. A new unused export or file under `packages/cli` is a regression.

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CLI-02 | Matrix pins pre-refactor output for default/graph/hooks/rules/events x text/`--format json`/`--json`/dot/dot+`--json`, selector precedence, one-document rule | unit (`it.effect`, `Output.capture`) | `npx vitest run --project cli packages/cli/test/PluginViews.test.ts` | Wave 0: create (green against untouched `Plugin.ts`, committed alone) |
| CLI-01 | Same matrix passes unchanged after `PluginViews.ts`; `Inspection.test.ts` unchanged | unit | same command plus `npx vitest run --project cli packages/cli/test/Inspection.test.ts` | exists (`Inspection.test.ts`) |
| CLI-01 | `Cli.ts` wires `format`/`--json` through the real argv | integration via `runCli` | included in `PluginViews.test.ts` | Wave 0 |
| CLI-03 | `config list` text and `--json` bytes unchanged, no secret leaks | unit | `npx vitest run --project cli packages/cli/test/Doctor.test.ts` | exists; edit lines 24 and 237 (swap `ConfigList.show` for `runCli(["config","list"], config)`) |
| CLI-03 | `ConfigList` gone from export and tree | grep | `grep -rn "ConfigList" packages spec docs examples features .changeset --exclude-dir=node_modules --exclude-dir=lib` returns only the changeset's `Migration:` prose | n/a |
| CLI-03 | Spec Revision matches Change History | gate | `pnpm spec:verify:strict` (check 14 "Document Control revision is current") | exists |
| CLI-04 | `openapi` stdout identical under text and `--json`; `Migration.apply` documents unchanged | unit | `npx vitest run --project cli packages/cli/test/Inspection.test.ts packages/cli/test/Migration.test.ts` plus a new pre-refactor `openapi --json` parity case | Wave 0: add the parity case (text stdout `deepStrictEqual` json stdout) before touching `Openapi.ts` |
| GATE-01 | All gates match baseline | gates | rows in the table above, plus `pnpm typecheck` | exists |
| GATE-02 | knip baseline recorded before code change | doc | `.planning/phases/01-cli-views-and-configlist-removal/01-BASELINE.md` exists and is committed first | Wave 0: create |
| GATE-03 | Changeset with `Migration:` line; Revision + Change History bumped together | file check | `grep -l "Migration:" .changeset/*.md` shows the new file; `pnpm spec:verify:strict` | Wave 0 of the last plan |

### Sampling Rate
- **Per task commit:** `npx vitest run --project cli` (about 3 s) and `npx tsc -b tsconfig.json && npx tsc -p tsconfig.test.json` (about 11 s)
- **Per wave merge:** add `pnpm circular`, `pnpm lint`, `pnpm format:check`, `pnpm check:error-tags`, `pnpm check:transactions` (all under 6 s combined)
- **Phase gate:** the full table: `pnpm test`, `pnpm test:bdd`, `pnpm coverage`, `pnpm spec:verify:strict`, `pnpm knip` (compared with baseline), `pnpm package:smoke` after `pnpm clean && pnpm build` (the export set changed); about 9 minutes total

### Wave 0 Gaps
- [ ] `.planning/phases/01-cli-views-and-configlist-removal/01-BASELINE.md` - the table above plus the raw `pnpm knip` output and the `git status --short`/`git diff --stat knip.json` at capture time (GATE-02)
- [ ] `packages/cli/test/PluginViews.test.ts` - matrix, committed green BEFORE any `src/` change (CLI-02). Suggested layout: a table of `{ app, view flags, mode }` rows driven by a loop, with inline expected `stdout` arrays for `hookedApp` (default, graph, hooks, rules) and `deepStrictEqual` of `documents[0]` to `Plugin.graph/hooks/rules/events(app)` for JSON cells; assert `stdout.length === 1` and `stdout[0] === JSON.stringify(rows, null, 2)` for json cells; assert `stderr` is empty everywhere; events text only needs header, first row and line count (25 for `hookedApp`, 31 for `passwordAndRoles`) plus "dot output equals text output"
- [ ] a pre-refactor `openapi` parity case (text stdout equals `--json` stdout) in the same or `Inspection.test.ts`
- [ ] No framework install needed

## Security Domain

`security_enforcement` is not set to false (no config file), so included, briefly.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2/V3/V4 Auth, Session, Access Control | no | the phase adds no endpoint or credential path |
| V5 Input Validation | yes (unchanged) | `--format` stays `Flag.Literals("format", ["text","json","dot"])` (`Cli.ts:187`); no new parsing |
| V6 Cryptography | no | none |
| V7 Error handling and logging | yes | failures still render through `Output.failure` on the global `--json` only; stdout stays the command's data and stderr the failure (BEH-EA-225) |
| V8 Data protection | yes | `config list` must keep printing `<redacted>` and never unwrapping a `Redacted` (BEH-EA-201, ECS-005); the existing canary test in `Doctor.test.ts:231-246` (`clientSecret = <redacted>`, `signingKey = <redacted>`, `databaseUrl = postgres://app:<redacted>@db.internal/app`) must still pass after the inline |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Secret value leaks via a richer view module handed manifest objects | Information disclosure | The views module only formats rows already built by `Plugin.ts` (no `Redacted`); keep `Output` receiving only already-redacted values |
| Failure document drift breaks a CI script | Tampering/Repudiation of exit contract | Do not touch `Output.failure`/`failureDocument`; `ExitCodes.test.ts` stays green |

## Sources

### Primary (HIGH confidence) - read this session
- `packages/cli/src/Plugin.ts` (all 288 lines), `Output.ts`, `ConfigList.ts`, `Cli.ts:1-240`, `Migration.ts`, `Openapi.ts`, `index.ts`, `Doctor.ts:120-279`
- `packages/cli/test/Inspection.test.ts` (all), `Doctor.test.ts:1-70,215-260`, `Migration.test.ts:1-60,140-175`, `support/RunCli.ts`, `support/TestApp.ts`, `support/HookedApp.ts`
- `spec/behaviors/26-cli.md` Document Control (Revision `1.9`, Change History through `1.9`), lines 46, 70, 398; `spec/scripts/check-drift.mjs:203-224`; `spec/scripts/verify-traceability.sh` header
- `package.json` scripts, `knip.json`, `vitest.config.ts`, `.changeset/config.json`, `CONTRIBUTING.md:95-104`, git history of `.changeset/` (commits `1cef4beb`, `e55def53`, `2c909ac5`)
- `.planning/` CONTEXT, REQUIREMENTS, STATE, `research/SUMMARY.md` and `PITFALLS.md` (19 and 20), `IMPLEMENTING.md`
- Gate runs and a throwaway output-dump test, all executed this session (results above)

### Secondary / Tertiary
- None. No web sources used: the work is entirely internal.

## Project Constraints (from AGENTS.md / IMPLEMENTING.md)
No `CLAUDE.md` exists at `./CLAUDE.md` or `./.claude/CLAUDE.md`, and no `.claude/skills` or `.agents/skills` directory exists.
- AGENTS.md: issues and specs live under `.scratch/`; domain docs point at `spec/` (`spec/overview.md`, `spec/decisions/`, `spec/behaviors/`, `spec/traceability.md`); plugin-authoring conventions in `docs/plugin-authoring.md`.
- IMPLEMENTING.md: no `as` / `as unknown as` / `as any` in library source; no return-type annotations on new Effect/Layer consts; replace-don't-layer tests (delete tests that re-test moved behaviour; for example the `ConfigList` import in `Doctor.test.ts` is replaced, not kept beside a new one); TDD (failing/pinning test first); run typecheck often (`npx tsc -b tsconfig.json && npx tsc -p tsconfig.test.json`); breaking changes carry a `Migration:` line; spec updates include Document Control revision and change history; `npx oxfmt <paths>` on new files; never leave the tree red; `pnpm knip` is treated as passing only if its only findings are the pre-existing ones (note: IMPLEMENTING.md says "~101 files under `.reports/`"; today's baseline additionally has the `.claude/` files and 3 unlisted deps, so compare against `01-BASELINE.md`, not that sentence).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies
- Architecture: HIGH - every precedence cell was executed, not inferred
- Pitfalls: HIGH - cycle risk and `Doctor.test.ts` callability derived from reading the code; `runCli` route executed
- Gate baseline: HIGH - every gate run on the untouched tree

**Research date:** 2026-11-14
**Valid until:** until `packages/cli/src` or `spec/behaviors/26-cli.md` changes on the branch; gate timings drift with machine load
