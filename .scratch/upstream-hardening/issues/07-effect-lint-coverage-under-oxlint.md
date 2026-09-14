# Effect-specific lint-rule coverage under `oxlint`

Type: research
Status: resolved
Research branch: research/effect-lint-coverage-under-oxlint

## Question

The pasted report's "adopt the effect-rules preset" claim assumes ESLint
(upstream's linter). This repo lints with `oxlint`
(`.oxlintrc.json`, exactly 1 rule today: `no-explicit-any`) — a different
tool with its own plugin/rule ecosystem, not a drop-in target for an
ESLint-only preset like `eslint-plugin-effect`/effect-rules.

Research: does `oxlint` have any Effect-specific rule support today (a
plugin, a built-in category, or planned/tracked support), and if not, what
are this repo's real options — running ESLint's effect-rules preset
*alongside* oxlint for just the Effect-specific subset (accepting two
linters), waiting on oxlint upstream, or something else? Separately,
confirm the current severity of every `@effect/language-service`
diagnostic actually surfaced in this repo (`tsconfig.base.json:68-77` sets
`ignoreEffectErrorsInTscExitCode: false`, meaning Effect *errors* already
fail tsc — but check whether any diagnostics are currently emitted only as
*warnings* that arguably should be errors) so the grilling ticket that
follows this one has real options instead of the pasted report's
ESLint-shaped ones.

## Answer

Researched 2026-09-14 on branch `research/effect-lint-coverage-under-oxlint`. All claims below are sourced inline; primary sources only (oxc-project/oxc repo, its docs site, npm registry, Effect-TS/language-service repo). This repo pins `oxlint ^1.82.0` (`package.json:41`) and `@effect/language-service ^0.87.2` (`package.json:33`), both of which are the current npm `latest` as of research date — findings below are against those versions.

### Q1 — Does oxlint have Effect-specific rule support today?

**No**, on every axis checked:

- **Built-in rule categories.** oxlint's native (Rust) plugin/category list is `eslint, typescript, react, unicorn, jsx-a11y, promise, vitest, import, jest, node, oxc, jsdoc, nextjs, vue, react-perf` (https://oxc.rs/docs/guide/usage/linter/rules.html). No `effect` category exists.
- **Tracked/planned support.** Searched `oxc-project/oxc` issues and discussions for "Effect-TS", "Effect.gen", and "effect" generally. The only Effect-adjacent item found is issue #23567, *"`@effect/vitest` support compatibility with oxlint's vitest rules"* (https://github.com/oxc-project/oxc/issues/23567) — closed 2026-07-02 as completed. That issue is about oxlint's existing `vitest/*` rule category not recognizing `@effect/vitest`'s re-exported `it`/`describe`/`test` as valid test-framework imports; it is a test-tooling detection fix, not an Effect-language-semantics rule (no `Effect.gen`/pipe/service-related rule request exists anywhere in the tracker).
- **Plugin/extensibility architecture.** oxlint does have a JS plugin system, but it's alpha (promoted via oxc-project/oxc PR #20281, "Promote JS plugins to alpha status" — https://github.com/oxc-project/oxc/blob/main/npm/oxlint/CHANGELOG.md) and ESLint-v9-plugin-API-compatible (https://oxc.rs/docs/guide/usage/linter/js-plugins, https://oxc.rs/blog/2026-03-11-oxlint-js-plugins-alpha). In principle an ESLint Effect plugin could be loaded as a `jsPlugins` entry in `.oxlintrc.json`, folding it into a single `oxlint` invocation instead of running ESLint separately. But the docs and maintainers are explicit that **"lint rules that rely on TypeScript type-awareness are not supported"** yet (same js-plugins doc; also stated in discussion #20245, "Oxlint JS Plugins compatibility" — https://github.com/oxc-project/oxc/discussions/20245, where type-aware rule sets in `eslint-plugin-sonarjs` and `@e18e/eslint-plugin` are cited as partially skipped for this reason). This is alpha-status and untested for any Effect plugin specifically — not something to depend on for CI today, but worth re-checking once it stabilizes.
- **Adjacent-but-not-it project:** `mpsuesser/effect-oxlint` (https://github.com/mpsuesser/effect-oxlint) exists on GitHub/npm/JSR, but it is a framework for *authoring* generic oxlint JS plugins using the Effect library's own idioms (typed errors, Option-based AST matching, Ref-based state) — it does not ship any Effect-specific rules itself, and has no official affiliation with oxc-project or Effect-TS.

### Q2 — Realistic options

**(a) Run ESLint's Effect-rules preset alongside oxlint, for the Effect-specific subset only.**

First, a correction to the pasted report's premise: there is no single official "effect-rules" ESLint preset with ~66 rules. The official `@effect/eslint-plugin` (`Effect-TS/eslint-plugin`, https://github.com/Effect-TS/eslint-plugin) currently ships **exactly 2 rules** — `dprint` (a formatting rule) and `no-import-from-barrel-package` (confirmed via `gh api repos/Effect-TS/eslint-plugin/contents/src/rules`, which lists only `dprint.ts` and `no-import-from-barrel-package.ts`). That is far short of "~66 Effect-specific rules."

The closest real match to what the pasted report likely meant is the community package `@codeforbreakfast/eslint-effect` (npm, latest `0.8.5`, source at `CodeForBreakfast/eventsourcing` monorepo, `packages/eslint-effect` — https://www.npmjs.com/package/@codeforbreakfast/eslint-effect). It ships **12 custom Effect-aware rules**: `no-unnecessary-pipe-wrapper`, `no-eta-expansion`, `no-unnecessary-function-alias`, `prefer-match-tag`, `prefer-match-over-conditionals`, `prefer-effect-if-over-match-boolean`, `prefer-match-over-ternary`, `no-switch-statement`, `no-if-statement`, `prefer-schema-validation-over-assertions`, `suggest-currying-opportunity`, `no-intermediate-effect-variables` (rule list confirmed from its README at `https://raw.githubusercontent.com/CodeForBreakfast/eventsourcing/main/packages/eslint-effect/README.md`), plus `recommended`/`strict` presets that also apply generic `no-restricted-syntax` bans (no classes, no `runSync`/`runPromise`, etc.) and an opt-in `functionalImmutabilityRules` preset that wraps `eslint-plugin-functional`. The report's "~66 rules" figure most plausibly comes from summing this plugin's rules with the wrapped `eslint-plugin-functional` rule set, not from one dedicated Effect plugin — worth treating the "66" number as approximate/composite if it resurfaces in a later ticket.

Coexistence is a documented, low-risk pattern, not a novel one: oxc's own migration guide (https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint) describes exactly this shape — *"1. Enable Oxlint for all supported rules 2. Keep ESLint for unsupported rules 3. Disable overlapping rules in ESLint"*, recommending sequential execution (`oxlint && eslint`) and pointing at `eslint-plugin-oxlint` to auto-disable ESLint rules that duplicate oxlint's. In this repo's specific case there is **no overlap to disable at all**: `.oxlintrc.json` configures exactly one rule (`no-explicit-any`), and none of the Effect-rule candidates above implement or duplicate that rule — so `eslint-plugin-oxlint` wouldn't even be needed; an ESLint config scoped to *only* the Effect plugin's rules (no `eslint:recommended`, no `@typescript-eslint` base rules) run as a second sequential command in the same CI step is exactly the pattern the official docs already endorse. No documented conflict exists between the two tools running over the same files for disjoint rule sets (neither runs autofix by default in CI).

**(b) Wait on oxlint upstream.** Not promising on any visible timeline: no roadmap milestone, issue, or discussion signals an Effect-specific built-in category (see Q1), and oxlint's stated strategy for filling gaps is "let ESLint plugins run via the JS-plugin bridge" rather than hand-rolling categories for every ecosystem — and there's no sufficiently popular/canonical Effect ESLint plugin (the official one has 2 rules) that would be a natural conformance-testing target the way `eslint-plugin-react-hooks` or `eslint-plugin-functional` are.

**(c) Other paths.** `@effect/language-service` is already the most Effect-native, actively maintained lint-adjacent tool in this stack, already wired into `tsconfig.base.json`, and already covers far more Effect-specific ground (77 named diagnostics across Correctness/Anti-pattern/Effect-native/Style categories, many with quick-fixes — see Q3) than any current ESLint/oxlint Effect plugin. The lowest-effort, highest-leverage improvement available today is tightening this tool's own severities (Q3) rather than standing up a second or third linter. No other standalone Effect-specific lint tool was found; Biome's plugin story (GritQL-based, experimental) was not investigated further as clearly out of scope (this repo doesn't use Biome).

### Q3 — `@effect/language-service` diagnostic severities in this repo

Source: `Effect-TS/language-service` README diagnostics table, `main` branch (https://github.com/Effect-TS/language-service/blob/main/README.md), which corresponds to the currently-released `@effect/language-service@0.87.2` (2026-08-07 — https://github.com/Effect-TS/language-service/releases) that this repo pins (`package.json:33`).

This repo's actual config, `tsconfig.base.json:70-76`:

```
"name": "@effect/language-service",
"diagnostics": true,
"namespaceImportPackages": [...],
"includeSuggestionsInTsc": false,       // line 73
"ignoreEffectWarningsInTscExitCode": true,  // line 74
"ignoreEffectErrorsInTscExitCode": false    // line 75
```

Key finding, sharper than the ticket's framing assumed: this isn't merely a case of the repo *not yet* promoting warnings — it has **actively opted out** of the tool's own default enforcement. The plugin's documented default for `ignoreEffectWarningsInTscExitCode` is **`false`** (i.e., by default, warning-level diagnostics *do* fail tsc's exit code) — quoting the README's options block: `"ignoreEffectWarningsInTscExitCode": false, // ... (default: false)`. This repo overrides that to `true`, meaning **all warning-level diagnostics are currently emitted but do not fail `tsc`**, contrary to the tool's own out-of-box behavior. Line 73 (`includeSuggestionsInTsc: false`, default `true`) additionally means suggestion-level diagnostics aren't even surfaced as tsc messages here — editor-only.

The diagnostics table (`README.md` lines ~53–141) lists 77 named diagnostics across 4 categories, each with a severity glyph (`➖` off, `❌` error, `⚠️` warning, `💡` suggestion). Breakdown as currently defaulted upstream:

- **10 error-level** (already fail tsc via `ignoreEffectErrorsInTscExitCode: false`): `classSelfMismatch`, `effectFnImplicitAny`, `floatingEffect`, `missingEffectContext`, `missingEffectError`, `missingLayerContext`, `missingReturnYieldStar`, `missingStarInYieldEffectGen`, `nonObjectEffectServiceType`, `overriddenSchemaConstructor`.
- **16 warning-level — emitted but NOT failing tsc in this repo today** (candidates for promotion to `error` via per-rule `diagnosticSeverity` overrides, or for flipping `ignoreEffectWarningsInTscExitCode` back to its own default of `false`):
  `duplicatePackage`, `genericEffectServices`, `outdatedApi`, `outdatedEffectCodegen`, `unsupportedServiceAccessors`, `effectFnIife`, `effectGenUsesAdapter`, `effectInFailure`, `effectInVoidSuccess`, `globalErrorInEffectCatch`, `globalErrorInEffectFailure`, `layerMergeAllWithDependencies`, `lazyPromiseInEffectSync`, `multipleEffectProvide`, `scopeInLayerEffect`, `unknownInEffectCatch`.
  Of these, `outdatedApi` ("detects usage of APIs that have been removed or renamed in Effect v4") stands out given this repo's stated v4 target (memory `effect-v4-and-qadi-sources`) — it's currently only a non-failing warning.
- **18 suggestion-level** (soft by design, and further suppressed from tsc output here by `includeSuggestionsInTsc: false`): `catchUnfailableEffect`, `leakingRequirements`, `returnEffectInGen`, `runEffectInsideEffect`, `schemaSyncInEffect`, `tryCatchInEffectGen`, `catchAllToMapError`, `effectFnOpportunity`, `effectMapFlatten`, `effectMapVoid`, `effectSucceedWithVoid`, `flatMapToMap`, `redundantSchemaTagIdentifier`, `schemaStructWithTag`, `unnecessaryEffectGen`, `unnecessaryFailYieldableError`, `unnecessaryPipe`, `unnecessaryPipeChain`.
- **33 off-by-default** (not emitted at all unless individually enabled, e.g. `deterministicKeys`, `strictBooleanExpressions`, `effectDoNotation`, and 21 "Effect-native API preference" rules like `globalConsole`/`globalFetch`/`processEnv` variants) — out of scope for "severity of diagnostics currently surfaced" since they aren't surfaced, but available as future opt-ins.

Per-rule severity overrides are supported today via `diagnosticSeverity` in the plugin's tsconfig options block (`"diagnosticSeverity": { "floatingEffect": "warning" }` per the README example) or inline via `// @effect-diagnostics <rule>:<severity>` comments — so promoting specific warnings to error is a config-only change, no tooling gap.

Sources consulted: `.oxlintrc.json`, `tsconfig.base.json:33,41,68-77`, `package.json:33,41`; `https://oxc.rs/docs/guide/usage/linter/rules.html`; `https://oxc.rs/docs/guide/usage/linter/js-plugins`; `https://oxc.rs/blog/2026-03-11-oxlint-js-plugins-alpha`; `https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint`; `https://github.com/oxc-project/oxc` issues/discussions (#23567, #20245, PR #20281); `https://github.com/Effect-TS/eslint-plugin`; `https://github.com/CodeForBreakfast/eventsourcing` (`packages/eslint-effect/README.md`); `https://www.npmjs.com/package/@codeforbreakfast/eslint-effect`; `https://github.com/mpsuesser/effect-oxlint`; `https://github.com/Effect-TS/language-service` (README.md, releases).

## Superseded by direct implementation (2026-09-14)

This ticket's Q2 answer above (run ESLint's `@codeforbreakfast/eslint-effect` alongside oxlint) turned out to be unnecessary — it was reasoning from the wrong premise, that oxlint had no real Effect-specific rules to draw on anywhere. It missed that `../effect` (`Effect-TS/effect`) ships its own private, unpublished `@effect/oxc` package (`packages/tools/oxc`) — real oxlint JS-plugin rules (`no-bigint-literals`, `no-import-from-barrel-package`, `no-js-extension-imports`, `no-opaque-instance-fields`, `no-unused-internal`) that the Effect team runs on their own monorepo today via oxlint's `jsPlugins` mechanism, loading the rule files as raw TypeScript with zero build step (Node's native type-stripping, confirmed working here on Node 22.22.0).

The user directed a straight port instead of the ESLint-dual-linter path, with a hard "never ESLint, keep oxlint" constraint. Done:

- Copied all 5 rule files verbatim into `tools/oxc/` (see that directory's own header comment for provenance).
- Wired `jsPlugins: ["./tools/oxc/index.ts"]` into `.oxlintrc.json`, with 4 of the 5 rules enabled (`no-unused-internal` is registered but disabled — see below).
- `no-import-from-barrel-package`'s `checkPatterns` scoped to `effect`/`@effect/*` only, deliberately **not** extended to this repo's own `@awthaq/*` scope — this repo's own packages rely on `export * as X from "./X.ts"` namespace barrels as a deliberate, working convention (see the original upstream-comparison evidence: "your namespace barrels hide less but scale better across 21 packages"), and forcing the same treatment onto them would fight that convention, not extend it.
- `@effect/vitest` carved out of the barrel-package regex (`(?!vitest$)`) — its per-symbol subpaths (`@effect/vitest/describe`, etc.) don't exist on disk; that package only ships `dist/index.js`. The rule's own heuristic (assume symbol name == subpath name) is wrong for flat-export packages; verified per-package before trusting any suggested path.
- **Enabling the rules surfaced ~374 real, pre-existing violations across 124 files** — legitimate barrel-style imports (`effect/unstable/httpapi`, `effect/unstable/sql`, `@effect/platform-node`, `@effect/sql-sqlite-node`, `effect/testing/TestClock`, plus every package's own test files importing their public API via `../src/index.ts`). Fixed all of them (mechanical import-statement rewrites only, no logic changes) — confirmed via full `pnpm check` (typecheck, lint, knip, format, circular, coverage, BDD, spec traceability) all green afterward.
- `no-unused-internal` is registered in `tools/oxc/index.ts` but **not enabled** — it drives TypeScript's classic compiler API (`ts.createSourceFile`, `ts.SyntaxKind`, etc.), which no longer exists at `typescript`'s top-level import under the tsgo/Corsa rewrite this repo pins (`typescript: ^7.0.0`; the package's root export is now just `./lib/version.cjs`, with the full compiler API moved to `typescript/unstable/*` submodules). Crashes at runtime as-is. Follow-up (not this ticket's scope): revisit once either effect's own rule is rewritten against TS7's new API shape, or this repo pins back to TS6.
