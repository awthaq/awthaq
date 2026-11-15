# Phase 1: CLI views and ConfigList removal - Context

**Gathered:** 2026-11-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Every `awthaq plugin` view (default list, `--graph`, `--hooks`, `--rules`, `--events`) renders through one views module that resolves `--format` and the global `--json` once, with output byte-identical to today. `ConfigList` leaves the `@awthaq/cli` export and the tree. `Migration.apply` and `Openapi` move onto the `Output` seam only where that changes no output. The gate baseline (knip, tsc -b, tests, circular, spec verify, coverage) is recorded before any code change. Requirements: CLI-01..04, GATE-01..03.

</domain>

<decisions>
## Implementation Decisions

### Output behaviour (preserve exactly)
- Today's precedence is the contract: on the graph view `--format dot` beats `--json`; `--format json` and `--json` both produce the JSON document for every view; hooks, rules and events have no dot branch; text is the fallback. A mode x (text, `--format json`, `--json`, dot) matrix over all views is written first and passes against the pre-refactor code. — **Reversibility:** costly — CLI output is consumed by scripts, and BEH-EA-225 (`--json` failure documents) pins the global flag.
- Failure rendering stays on the global `--json` only: `--format json` does not change how failures are rendered. Making `--format json` imply `--json` globally would change observable failure output, so it is not done. — **Reversibility:** costly — changes the stderr failure contract of BEH-EA-225.

### ConfigList removal
- `ConfigList` is removed from the package export and the tree (CLI-03). The `config list` command keeps its output byte-for-byte. The released-surface change is announced by a changeset with a `Migration:` line, and `spec/behaviors/26-cli.md` (citations at lines 46 and 398, BEH-EA-202/225/229) is updated with Revision and Change History bumped together. — **Reversibility:** costly — a public barrel export disappears (the package is unpublished, so no external consumer is broken).

### Decided autonomously
- [Views module] Q: "Where does the views module live?" → Selected: "A new file `packages/cli/src/PluginViews.ts`, re-exported through the existing `Plugin` namespace only if tests need it" — a new internal file is trivially moved or merged back.
- [Views module] Q: "Shape: one function per view or a table keyed by selector?" → Selected: "One internal view descriptor (rows builder + text renderer + dot capability) per view, and a single `render` that selects by the options" — internal shape, no external contract.
- [Views module] Q: "Where is format resolved?" → Selected: "One function that maps (`--format`, `out.json`) to `text | json | dot` once per command" — private to the module, replaced by editing one function.
- [Output seam] Q: "How does the views module reach `Output.report`?" → Selected: "Extend `Output.report` with an optional explicit-format override rather than re-implementing the branch, and keep its current behaviour when the option is absent" — additive optional parameter, callers unaffected.
- [Output seam] Q: "Which of `Migration.apply` and `Openapi` move onto `Output.report`?" → Selected: "Only the call sites whose captured stdout, stderr and documents stay identical under the existing tests; the rest are left and the reason is recorded in the plan summary" — per-call-site, each revertible alone.
- [ConfigList] Q: "Where do the three lines of `ConfigList.show` land?" → Selected: "Inline into the `config list` command handler in `Cli.ts`; `Doctor.configContext` and `Doctor.descriptorsOf` lose their export if nothing else uses them (knip decides)" — a local move.
- [ConfigList] Q: "Changeset bump level for the removed export?" → Selected: "minor, following the `test-app-removed` precedent (the project is unpublished, so no 1.0)" — a changeset file is edited in one line.
- [Tests] Q: "Where does the matrix live and how are outputs asserted?" → Selected: "`packages/cli/test/PluginViews.test.ts` on `Output.capture`, asserting stdout lines and documents against inline expected values, committed green before the refactor" — test file layout is local.
- [Tests] Q: "What happens to the existing `Doctor.test.ts` use of `ConfigList.show`?" → Selected: "It calls the inlined entry point through the same `Output.capture` layer; the assertion is unchanged" — a mechanical import swap.
- [Gates] Q: "How is the knip baseline recorded?" → Selected: "A committed `.planning/phases/01-.../01-BASELINE.md` with the raw `pnpm knip` output (3 unlisted deps in `packages/sql/test/fixtures/readme-quickstart.ts`, `.reports/`, untracked `.claude/`) captured before any code change, and later phases compare against it" — a documentation file.

### Claude's Discretion
Internal naming of the views module's exports, the exact test-case table layout, and the wording of the changeset and spec Change History entries.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/cli/src/Output.ts`: `Output` service with `layerConsole(json)` and `capture(json)`, plus `report(value, render)` which honours only `out.json`.
- `packages/cli/src/Plugin.ts` (`show` at ~line 255): repeats the `options.format === "json" || out.json` branch for hooks, rules, events and the graph; renders text via `renderHooks`, `renderRules`, `renderEvents`, `renderText`, `renderDot`.
- `packages/cli/src/ConfigList.ts` (about 9 lines of logic): already uses `Output.report`; cited by `Doctor.test.ts:24,237`, `Cli.ts:40,152`, `index.ts:12`.

### Established Patterns
- Tests read output through `Output.capture(json)` (stdout lines, stderr lines, documents).
- `Migration.ts:64` already uses `Output.report`; `Migration.ts:88-117` and `Openapi.ts` branch on `out.json` by hand.

### Integration Points
- `Cli.ts` command handlers, `index.ts` barrel, `spec/behaviors/26-cli.md`, `.changeset/`.

</code_context>

<specifics>
## Specific Ideas

No specific requirements beyond REQUIREMENTS.md and research/SUMMARY.md (Phase 1 section, pitfalls 19 and 20).

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>
