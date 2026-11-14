# Phase 2: Split TestAuth - Research

**Researched:** 2026-11-14
**Domain:** TypeScript module restructure of a test-harness facade (`packages/test/src/TestAuth.ts`, 1869 lines) with a frozen public name set, a module-level leak counter, and spec citations
**Confidence:** HIGH (every claim below was read or run in this worktree at HEAD `34a223ca8b2eb49fb53e18e255f4bd344f232654`; no external library behaviour is in question, so no web or Context7 lookups were needed)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
CONTEXT.md has no `## Decisions` list of locked choices; its `## Implementation Decisions` section contains only "Claude's Discretion" plus constraints "fixed by REQUIREMENTS.md and the ROADMAP success criteria, not choices". Copied verbatim below.

### Claude's Discretion
All implementation choices are at Claude's discretion: this is a pure infrastructure phase (a restructure with only technical success criteria and no user-facing behaviour). The constraints below are fixed by REQUIREMENTS.md and the ROADMAP success criteria, not choices:

- The exported `TestAuth.*` name set is diffed mechanically before and after (record the "before" set in Wave 0, before any `src` change), and the diff must be empty. Types count as part of the surface (`export type`, interfaces, overloads of `layer`).
- Module boundaries follow the roadmap: composition, session/CSRF minting, app harness, contract runner. The existing `internal/foundation.ts`, `internal/contract.ts` and `internal/storeContract/` are the in-package precedent for barrel-plus-`internal/`; extend that pattern rather than inventing a new one.
- `openAppCount`, `openApps`, `serve` (the increment at the start of a served app and the decrement on release) must end up in the same module, so a reader of the counter sees every write to it. `LeakGuard` tests and the 12 `Schema.lock.test.ts` files pass unedited.
- `internal/` modules must not import `TestAuth.ts`: `pnpm circular` counts type-only imports, so a facade that re-exports from modules that import the facade's types back is a cycle. Shared types move into `internal/` and are re-exported from the facade.
- `buildContext` remains exported from `TestAuth.ts`; `migratedSchema` keeps calling `TestSql.schemaOf`.
- Spec citations: `spec/behaviors/25-testing-harness.md` (the `*Implementation*` lines near 313, 336, 356, 372 and the header references) and `spec/traceability.md` (lines near 51 and 336-338) cite the new locations while keeping the cited test file names. Bump each touched spec file's Revision and Change History together (`pnpm spec:verify:strict` check 14).
- Verification discipline carried over from Phase 1: record the gate baseline and the export-name-set snapshot before any `src` change; run `npx tsc -b tsconfig.json` after each extraction; gates are those in `.planning/phases/01-cli-views-and-configlist-removal/01-BASELINE.md` (Postgres-gated tests cannot run locally, record "not run locally").
- No consumer file outside `packages/test` may need an edit. If one does, that is a surface change and a plan defect, not an implementation detail.

User's standing instruction for the milestone (CONTEXT `<specifics>`): the cleanest solution, not the simplest; complexity is accepted.

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope. (Phase 7's test-host composer for the BDD Worlds is separate and lives in `features/step-definitions/shared`.)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TEST-01 | `TestAuth.ts` split into `internal/` modules (composition, session/CSRF minting, app harness, contract runner), stays a facade; exported name set identical | Section "Exported surface" (47 names, 23 values + 24 types), section "Section map and dependency graph", surface-snapshot method, runtime key pin |
| TEST-02 | `buildContext` kept; `migratedSchema` still calls `TestSql.schemaOf` | `buildContext` is `TestAuth.ts:931`; `TestSql.schemaOf` is called at `TestAuth.ts:1152` inside `applyMigrationsOn`, which `migratedSchema` reaches through `applyMigrations`: all three must land in one module (contract runner) |
| TEST-03 | Open-app counter beside `serve`/`openApps`; `LeakGuard` accounting unchanged | `openAppCount` has exactly 4 occurrences (`TestAuth.ts:626,627,662,760`); all live in the app-harness section; tests that pin it listed in "LeakGuard and Schema.lock" |
| TEST-04 | `25-testing-harness.md` and `traceability.md` cite new locations, keep test file names | Exact citation lines and Document Control state in "Spec citations" |
</phase_requirements>

## Summary

The split is mechanically clean: the file has four contiguous concern sections plus a small set of shared helpers, and the dependency graph between them is a DAG with no back-edges once three decisions are made. (1) `withRequest`/`withoutRequest` are used by both the session section (`signInAs`) and the app harness (`make`, `ServeOptions`), so they must live in the session module and the harness imports them; no fifth module is needed. (2) `makeLayer` and `recordModes` are used by both composition and the contract runner, so composition exports them (internally only) and the contract runner imports composition. (3) The two vestigial exported types `RetentionRegistryService`/`FoundationServices` (`TestAuth.ts:150-156`) belong with `internal/foundation.ts`. No type is shared by two sections in a way that needs a shared-types module. [VERIFIED: identifier-scan of `TestAuth.ts` by section, this session]

**The phase has one fact the CONTEXT does not know about, and it breaks success criterion 1 as literally worded.** Two source-census tests in `packages/core/test` (`SignInSeams.test.ts`, `RequestContextSeams.test.ts`) pin exact per-file match counts keyed by the path `test/src/TestAuth.ts`. After the split the matches move to other files, so those two tests fail unless four `file:` string literals are edited. They are not consumers of `TestAuth.*` (they read source text, import nothing), the surface does not change, and there is no way to keep the counted constructs in the facade (`signInAs` belongs to the session module). The plan must edit those four literals in the same commit as the extraction that moves each construct, and this needs the user's acknowledgment as a stated exception to "no file outside `packages/test` is edited" (see Open Question 1). [VERIFIED: read both files and ran them green at HEAD: 17 tests pass]

The public surface can be snapshotted mechanically, but not with `typescript`'s compiler API: this repo's `typescript` is 7.0.2 (the native tsgo build), whose package exposes only `version` and `versionMajorMinor` to `require()`. A working probe exists using the transitive `typescript@5.9.3` copy in the pnpm store (47 names, deterministic, 176 lines), plus a cheap permanent runtime-key pin test for the 23 value names. Use both.

**Primary recommendation:** Extract leaf-first in four commits (`internal/session.ts`, `internal/composition.ts`, `internal/appHarness.ts`, `internal/contractRunner.ts`), each followed by `npx tsc -b tsconfig.json`, the `packages/test` project run, and the two core census tests; make `TestAuth.ts` a facade of named re-exports only (never `export *`); capture the surface BEFORE and diff AFTER; then edit three spec files and run the Phase 1 gate list.

## Architectural Responsibility Map

This phase has no browser/SSR/API/DB tiers: it reshapes one library package. The relevant "tiers" are modules inside `@awthaq/test`; this is the map the planner should check task assignments against.

| Capability | Primary module | Secondary | Rationale |
|------------|---------------|-----------|-----------|
| Test ports, `makeLayer`, `layer` overloads, `CommonOptions`/`SqlMode`/`MemoryMode`, `TestCsrfConfig`, `recordModes`, `encryption`, `httpClient` | `internal/composition.ts` | — | One implementation behind every `layer` overload (`TestAuth.ts:311-312` doc); `AuthHost.layer` over test ports (BEH-EA-342) |
| `withRequest`, `withoutRequest`, `signInAs`, `sessionSetCookie`, `csrfToken`, `csrfSetCookie`, `SignedInSession` | `internal/session.ts` | harness imports it | Mint-without-HTTP primitives; request-fact scoping is used only by minting and by the harness |
| `App`, `ServeOptions`, `make`, `serve`, `listen`, `withApp`, `lazyApp`, `buildContext`, `openApps`/`openAppCount`, agent types | `internal/appHarness.ts` | imports `session.ts` | The counter must sit beside every write to it (TEST-03) |
| `runPluginContractTests`, `migratedSchema`, `applyMigrations*`, `throwingFramework`, `ContractTestOptions`, `RecordsOption` | `internal/contractRunner.ts` | imports `composition.ts` (`makeLayer`, `recordModes`) and `foundation.ts` (`memoryFoundation`) | `migratedSchema` reaches `TestSql.schemaOf` only through `applyMigrationsOn` (TEST-02) |
| `RetentionRegistryService`, `FoundationServices` (types) | `internal/foundation.ts` | — | Both are foundation-registry type names; vestigial but exported |
| Public surface and header doc | `TestAuth.ts` (facade) | — | Named re-exports only; keeps the header that spec lines 59, 95 and the feature file cite |

## Exported surface of `TestAuth.ts` (item 1)

`packages/test/src/index.ts:13` is `export * as TestAuth from "./TestAuth.ts";` [VERIFIED: packages/test/src/index.ts:13]. The package has a single export entry: `"exports": { ".": { "types": "./lib/index.d.ts", "bun": "./src/index.ts", "import": "./lib/index.js", "default": "./lib/index.js" } }` [VERIFIED: packages/test/package.json]. So `TestAuth.*` is exactly the set of names the facade exports, and consumers can only reach it through `@awthaq/test` (or, inside the package, `../src/TestAuth.ts`).

**47 exported names: 23 values + 24 types** (measured with the compiler-API probe below; both kinds resolved through aliases):

Values (23): `buildContext`, `csrfSetCookie`, `csrfToken`, `encryption`, `httpClient`, `layer` (2 overloads: `MemoryMode` and `SqlMode`, `TestAuth.ts:388-421`, implementation signature at 422 not visible), `lazyApp`, `listen`, `memoryFoundation` (re-export, `TestAuth.ts:160`), `migratedSchema`, `openApps`, `recordModes`, `runPluginContractTests`, `runSealedColumnTests` (re-export, 1860), `runTenantIsolationTests` (re-export, 1862), `serve`, `sessionSetCookie`, `signInAs`, `TestCsrfConfig`, `throwingFramework`, `withApp`, `withoutRequest`, `withRequest`.

Types (24): `AgentOptions`, `App`, `AppNeeds`, `CommonOptions`, `ContractTestOptions`, `FoundationServices`, `KeyedProbe` (re-export), `LazyApp`, `ListeningApp`, `MemoryMode`, `MethodClass` (re-export), `Probe` (re-export), `RecordsOption`, `RequestInit`, `RetentionRegistryService`, `SealedColumnConfig` (re-export), `ServeOptions`, `SignedInAgent`, `SignedInSession`, `SignInOptions`, `SqlMode`, `TableCase` (re-export), `TenantIsolationConfig` (re-export), `TestFramework` (re-export of `./TestFramework.ts`, line 1105).

Not exported and must stay unexported (they appear inside the inferred type of `layer`, and `makeLayer` is imported by the contract runner): `Provided`, `Requires`, `TestProvided`, `Guarded`, `GuardIn`, `makeLayer`, `testPorts`, `TestHasher`, `GuardLive`, `make`, `serialize`, `EVENT_SAMPLES`, `TABLE_PREFIX_PATTERN`, etc. `TestAuth.app` is NOT an export (it is mentioned only in comments; spec 1.12 removed it). [VERIFIED: probe output `before.txt`; `grep` of `^export` in TestAuth.ts]

**Usage frequency of the surface across the monorepo** (grep of `TestAuth\.<name>` in `*.ts/*.tsx`, excluding node_modules/lib/.claude/.planning/.plan/.scratch): `withoutRequest` 680, `layer` 336, `serve` 115, `withRequest` 77, `runPluginContractTests` 58, `withApp` 43, `httpClient` 29, `openApps` 24, `signInAs` 23, `runSealedColumnTests` 20, `throwingFramework` 16, `lazyApp` 15, `App` 15, `migratedSchema` 13, `memoryFoundation` 13, `recordModes` 10, `buildContext` 6, `encryption` 5 (others lower). `RetentionRegistryService`, `FoundationServices` and `CommonOptions`-by-name have no consumer outside the file; they are still surface and must be preserved. [VERIFIED: grep this session]

### How to snapshot the surface mechanically

**Why not the obvious route:** `typescript` here is `7.0.2` (`pnpm-workspace.yaml:40: typescript: 7.0.2`; `npx tsc -v` prints `Version 7.0.2+effect-tsgo.0.67.4`), and `require("typescript")` returns an object with only `version` and `versionMajorMinor`: there is no `createProgram`/`getTypeChecker`. [VERIFIED: ran `node -e` against `require.resolve('typescript')`] A `tsc --declaration` dump is not comparable before/after (the facade's `.d.ts` becomes `export { x } from "./internal/..."` lines).

**Method that works (measured):** the pnpm store holds a transitive `typescript@5.9.3` (via `@typescript-eslint`, `pnpm-lock.yaml:4047`). It is not a declared dependency, so treat it as a one-off measuring instrument, never as a committed dependency. The probe below prints, for every export of the module, its kind (value/type/namespace), the type of values, and the member list of interfaces; it is deterministic (two runs identical) and path-independent (`import(` count in output: 0, no `any` leaks, so every module resolved).

**Knip trap:** do NOT commit the probe as a `.cjs`/`.mjs`/`.ts` file anywhere in the repo. `pnpm knip` reports unused files repo-wide (it reports 39 under untracked `.claude/` today), so a committed script would be a new "Unused files" row and a Phase 1 baseline regression. Write it to a temp path at Wave 0 from this document and commit only the `.txt` outputs (`02-SURFACE-BEFORE.txt`, later `02-SURFACE-AFTER.txt`), which knip ignores.

```js
// probe.cjs — run from the repo root:
//   TS_API_PATH=$PWD/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript \
//     node probe.cjs packages/test/src/TestAuth.ts > 02-SURFACE-BEFORE.txt
const path = require("node:path");
const root = process.cwd();
const ts = require(process.env.TS_API_PATH);
const entry = path.resolve(process.argv[2] ?? "packages/test/src/TestAuth.ts");
const cfg = ts.getParsedCommandLineOfConfigFile(
  path.join(root, "packages/test/tsconfig.src.json"), {},
  { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); } },
);
const program = ts.createProgram({
  rootNames: [entry],
  options: { ...cfg.options, composite: false, incremental: false, noEmit: true, tsBuildInfoFile: undefined },
});
const checker = program.getTypeChecker();
const sf = program.getSourceFile(entry);
const mod = checker.getSymbolAtLocation(sf);
const F = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope | ts.TypeFormatFlags.MultilineObjectLiterals;
const lines = [];
for (const sym of checker.getExportsOfModule(mod).sort((a, b) => a.name.localeCompare(b.name))) {
  const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  const kinds = [];
  if (target.flags & ts.SymbolFlags.Value) kinds.push("value");
  if (target.flags & ts.SymbolFlags.Type) kinds.push("type");
  if (target.flags & ts.SymbolFlags.Namespace) kinds.push("namespace");
  lines.push(`## ${sym.name} [${kinds.join("+")}]`);
  if (target.flags & ts.SymbolFlags.Value) lines.push(`value: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(target, sf), sf, F)}`);
  if (target.flags & ts.SymbolFlags.Type) {
    const t = checker.getDeclaredTypeOfSymbol(target);
    const tps = (t.aliasTypeArguments ?? t.typeParameters ?? []).map((p) => checker.typeToString(p)).join(", ");
    lines.push(`type<${tps}>: ${checker.typeToString(t, sf, F | ts.TypeFormatFlags.InTypeAlias)}`);
    if (target.flags & ts.SymbolFlags.Interface) {
      for (const p of checker.getPropertiesOfType(t).sort((a, b) => a.name.localeCompare(b.name))) {
        const opt = p.flags & ts.SymbolFlags.Optional ? "?" : "";
        const decl = p.valueDeclaration ?? p.declarations?.[0];
        const ro = decl && ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Readonly ? "readonly " : "";
        lines.push(`  ${ro}${p.name}${opt}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(p, sf), sf, F)}`);
      }
    }
  }
}
process.stdout.write(lines.join("\n") + "\n");
```

Acceptance: `grep -c '^## ' 02-SURFACE-BEFORE.txt` is 47; after the split, `diff 02-SURFACE-BEFORE.txt 02-SURFACE-AFTER.txt` is empty (`entry` stays `packages/test/src/TestAuth.ts`, the facade). [VERIFIED: 47 names, 176 lines, rerun-identical; TS 5.9.3 handled `module: Preserve`, `rewriteRelativeImportExtensions` and the `@awthaq/*` paths]

**Fragility to tell the planner:** if `typescript@5.9.3` is gone from the store after a lockfile refresh, fall back to the two permanent pins below plus `tsc -b` and `tsc -p tsconfig.test.json`; do not add a dependency for this.

**Permanent pins (cheap, committed, knip-safe because they are tests):**
1. `packages/test/test/TestAuthSurface.test.ts`: `assert.deepStrictEqual(Object.keys(TestAuth).sort(), [<the 23 value names>])`, importing `../src/TestAuth.ts` like its sibling tests. It must be green BEFORE any `src` change (Wave 0) and after. It catches a leaked internal helper (`makeLayer`) or a dropped value; it cannot see types.
2. Optional type-name existence pin (`TestAuthSurface.types.test.ts` with `type _A = TestAuth.AgentOptions; ...` for the 24 types), type-checked by `npx tsc -p tsconfig.test.json`. Catches a dropped type name only.

## Standard Stack

No library is added. The phase uses what the package already has.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `effect` | 4.1.2 [CITED: task brief: "this repo runs effect@4.1.2"] | Layer/Effect/Scope used by every moved block | Unchanged; `.planning/IMPLEMENTING.md`'s `effect@4.0.0-rc.116` is stale |
| `typescript` (tsgo) | 7.0.2 [VERIFIED: pnpm-workspace.yaml:40, `npx tsc -v`] | `tsc -b` after each extraction; declaration emit | `declaration: true`, `verbatimModuleSyntax: true`, `noUnusedLocals: true`; no `isolatedDeclarations` [VERIFIED: tsconfig.base.json:25,35,39; grep for `isolatedDeclarations`/`isolatedModules` found nothing] |
| `vitest` + `@effect/vitest` | 5.0.2 / ^4.1.2 [VERIFIED: pnpm-workspace.yaml; run banner `RUN v5.0.2`] | Package and census tests | Root `projects: ["packages/*", ...]`; project names `test`, `core` |

### Supporting (gates, already installed)
`madge` via `scripts/circular.mjs` (value and type-inclusive cycle passes), `knip` ^6.44.1, `oxlint`, `oxfmt`. [VERIFIED: package.json scripts; scripts/circular.mjs]

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Four modules | A fifth `internal/request.ts` for `withRequest`/`withoutRequest` | Cleaner naming, but the roadmap names four modules and the helpers are 18 lines that only the session module and harness use; recommended: keep in `session.ts` |
| One contract-runner module (about 880 lines) | Split into `contractRunner.ts` + `schemaChecks.ts` | More files, no new seam (the helpers feed only the runner); not recommended unless the user wants smaller files |

**Installation:** none. **Version verification:** no package is installed or bumped this phase.

## Package Legitimacy Audit

No external packages are installed or added by this phase; `gsd-tools package-legitimacy` was not run. The transitive `typescript@5.9.3` used by the one-off probe is already in `pnpm-lock.yaml:4047` and is not added to any `package.json`.

## Architecture Patterns

### Section map of `TestAuth.ts` (item 2)

| Lines | Content | Destination |
|-------|---------|-------------|
| 1-63 | Header comment (BEH-EA-193..200, signInAs notes) | Stay in the facade (spec 25 lines 59 and 95 and the `.feature` line 68 point at "TestAuth.ts's header"); reword the one "wired in below" at line 6 |
| 64-130 | Imports | Split per module (table below) |
| 132-147 | `TestHasher` (argon2id at `AUTH_ARGON2_MEMORY_KIB: "1024", AUTH_ARGON2_ITERATIONS: "1"`) | composition |
| 149-156 | `export type RetentionRegistryService`, `FoundationServices` | foundation.ts (with `@public`, as `FoundationRegistries` is) |
| 158-160 | `export { memoryFoundation } from "./internal/foundation.ts"` | facade (keep) |
| 162-189 | `testPorts`, `fixedClientAddress` | composition |
| 191-212 | `withRequest`, `withoutRequest` | session (see coupling) |
| 214 | `GuardLive` | composition |
| 216-227 | `TestCsrfConfig`, `recordModes` | composition |
| 229-428 | `CommonOptions`, `SqlMode`, `MemoryMode`, `TestProvided`, `Guarded`, `GuardIn`, `Provided`, `Requires`, `makeLayer`, `layer` x2 overloads + impl | composition |
| 430-538 | `SignedInSession`, `serialize`, `sessionSetCookie`, `signInAs`, `csrfToken`, `csrfSetCookie` | session |
| 540-937 | `RequestInit`, `AgentOptions`, `SignInOptions`, `SignedInAgent`, `App`, `AppNeeds`, `openAppCount`/`openApps`, `ServeOptions`, `make`, `serve`, `ListeningApp`, `listen`, `withApp`, `LazyApp`, `lazyApp`, `buildContext` | appHarness |
| 939-972 | `encryption`, `clientReturning`, `httpClient` | composition (test ports and doubles; used by no other section) |
| 974-984 | `throwingFramework` | contractRunner (it wraps `TestFramework`) |
| 986-1856 | `RecordsOption`, `ContractTestOptions`, `EVENT_SAMPLES`, `sampledEventProblems`, `applyMigrations`, `applyMigrationsOn`, `migratedSchema`, `declarationProblems`, `ownershipViolations`, `TABLE_PREFIX_PATTERN`, `runOnScratchPoint`, `abortOf`, `dependencyClosure`, `runClosed`, `keysOf`, `recordsParityProblems`, `runPluginContractTests` | contractRunner |
| 1105 | `export type { TestFramework } from "./TestFramework.ts"` | facade (keep; the contract runner imports the type from `../TestFramework.ts` directly) |
| 1858-1869 | `runSealedColumnTests`, `runTenantIsolationTests` and their types re-exported from siblings | facade (keep unchanged) |

### Bindings used by more than one section (the "fifth module" question)

| Binding | Used by | Resolution |
|---------|---------|------------|
| `withRequest` / `withoutRequest` | session `signInAs` (`TestAuth.ts:473,487`), harness `make` (669) and `ServeOptions.request: Parameters<typeof withRequest>[0]` (644) | Define in `session.ts`; harness imports. No cycle: harness -> session only. |
| `signInAs`, `csrfSetCookie` | harness `make` (699, 722) | Exported by `session.ts`, imported by harness |
| `makeLayer` | contract runner `build` check (1688, 1693) | Exported (internal-only) from `composition.ts`; MUST NOT be re-exported by the facade |
| `recordModes` | contract runner (1678) and public | Defined in composition, imported by contract runner, re-exported by facade |
| `memoryFoundation` | contract runner `recordsParityProblems` (1357, 1360) | Imported straight from `./foundation.ts` |
| `dependencyClosure` | `migratedSchema` (1161) and runner (1427, 1853) | Same module, no export needed |
| `TABLE_PREFIX_PATTERN` | `ownershipViolations` (1254) and runner (1488) | Same module |
| `serialize` | `sessionSetCookie` (455) and `csrfSetCookie` (524) | Same module (session) |
| `TestFramework` type | `throwingFramework` (975), runner (1418), facade re-export | contractRunner imports from `../TestFramework.ts`; facade re-exports from the same file |

**Result: no binding forces a fifth module and no shared-types module is needed.** Import DAG: `appHarness -> session`; `contractRunner -> composition, foundation`; `composition`, `session`, `foundation` are leaves (apart from sibling leaves like `../TestSql.ts`, `../TestEncryption.ts`, `../RedactionGuard.ts`, `../TestMailbox.ts`); the facade imports all four. Nothing in `packages/test/src` imports `TestAuth.ts` except `index.ts:13` [VERIFIED: `grep` for `TestAuth.ts` under packages/test/src], so `internal/` importing the facade would be the only way to create a cycle; `pnpm circular` (`scripts/circular.mjs`) runs a value pass and a type-inclusive pass and fails on either.

### Imports needed per module (identifier scan; `noUnusedLocals` is on, so `tsc -b` is the check)

| Import | composition | session | harness | contract |
|--------|:-:|:-:|:-:|:-:|
| `Api` (`@awthaq/api`) | | x | x | x |
| `Auth` | x | | | x |
| `AuthEvents` | x | | | |
| `AuthPlugin` | x | | | x |
| `EventDefinition`, `HookPoint`, `Migrations` | | | | x |
| `SessionCookie` | | x | x | |
| `Sessions`, `Users` (types and values) | x | x | x | |
| `ClientAddress`, `PasswordHasher`, `RateLimiter`, `Mailer`, `SmsSender` | x | | | |
| `Defects` | | | x | |
| `AuthHost`, `Credentials` | x | | | |
| `Csrf` | x | | x | |
| `CoreMigrations` | | | | x |
| `UserAgent` | | | x | |
| `RecordsContract` | | | | x |
| `RedactionGuard`, `TestEncryption`, `TestSql` | x | | | x (`TestMailbox` only composition) |
| `NodeCrypto`, `ConfigProvider`, `HttpClient`, `HttpClientError`, `HttpClientResponse`, `HttpApiGroup` (type) | x | | | |
| `NodeHttpServer`, `node:http`, `Clock`, `Duration` (type), `ManagedRuntime`, `Scope`, `SynchronizedRef`, `TestClock`, `HttpServerRequest`, `NetAddress` | | | x | |
| `createHmac`, `randomBytes`, `Cookies` | | x | | |
| `SqliteClient`, `Arbitrary`, `Cause`, `Schema`, `HttpApi`, `Migrator`, `SqlClient` | | | | x |
| `HttpRouter`, `HttpServer` | x | | x | |
| `Context`, `Exit`, `Option` | | | x | x (`Option` also composition, harness) |
| `Layer`, `Effect`, `Redacted` | x | x (`Effect`, `Redacted`) | x | x |

(`Redacted` in the contract column is a string-literal false positive and is not needed there.) The foundation type aliases need `AuthEvents`, `DataExport`, `Erasure`, `Retention`, `Encryption` (already imported by `internal/foundation.ts` except `AuthEvents` is imported there as a value: confirmed at `foundation.ts:5-13`).

### System data flow (module level)

```
@awthaq/test index.ts  --export * as TestAuth-->  TestAuth.ts (facade: named re-exports + header)
                                                      |
        +---------------+-----------------+-----------+-----------------+
        v               v                 v                             v
 internal/session.ts  internal/composition.ts   internal/appHarness.ts   internal/contractRunner.ts
   withRequest ...      testPorts, GuardLive,       openAppCount, make,        runPluginContractTests,
   signInAs, csrf*      makeLayer, layer            serve/listen/withApp,      migratedSchema,
        ^               recordModes, TestCsrfConfig lazyApp, buildContext      applyMigrationsOn -> TestSql.schemaOf
        |                    ^   ^                       |                          |        |
        +--- imported by ----|---|-----------------------+                          |        |
                             |   +-------- makeLayer, recordModes ------------------+        |
                             +------------ memoryFoundation (internal/foundation.ts) <--------+
```

### Recommended file layout and naming

```
packages/test/src/
├── TestAuth.ts                  # facade: header comment + named `export { } from` / `export type { } from`
└── internal/
    ├── foundation.ts            # existing; gains RetentionRegistryService, FoundationServices (+ @public)
    ├── contract.ts              # existing verdict machinery (do NOT reuse this filename)
    ├── composition.ts           # new
    ├── session.ts               # new
    ├── appHarness.ts            # new
    ├── contractRunner.ts        # new (`contract.ts` is taken)
    └── storeContract/           # existing
```
File names are `[ASSUMED]` discretion (camelCase like `storeContract/`); `contract.ts` is already taken, so `contractRunner.ts` avoids a clash.

### Pattern: facade with named re-exports only
**What:** `export { a, b } from "./internal/x.ts"; export type { T } from "./internal/x.ts";` in the style already used at `TestAuth.ts:160` and `1860-1869`. **Never `export *`** (it would add `makeLayer` to the surface; the runtime key pin and the probe both catch it). `verbatimModuleSyntax` requires `export type {}` (or inline `type`) for types.

Facade export list (23 values + 24 types = 47):
- composition: `TestCsrfConfig, recordModes, layer, encryption, httpClient`; types `CommonOptions, SqlMode, MemoryMode`
- session: `withRequest, withoutRequest, sessionSetCookie, signInAs, csrfToken, csrfSetCookie`; type `SignedInSession`
- appHarness: `openApps, serve, listen, withApp, lazyApp, buildContext`; types `RequestInit, AgentOptions, SignInOptions, SignedInAgent, App, AppNeeds, ServeOptions, ListeningApp, LazyApp`
- contractRunner: `migratedSchema, runPluginContractTests, throwingFramework`; types `RecordsOption, ContractTestOptions`
- foundation: `memoryFoundation`; types `RetentionRegistryService, FoundationServices`
- existing lines kept: `TestFramework` type (1105), `runSealedColumnTests`, `runTenantIsolationTests` and their types (1860-1869)

### Anti-Patterns to Avoid
- **`export * from "./internal/..."` in the facade:** leaks `makeLayer` and any helper you exported only for a sibling.
- **Exporting from `internal/` anything no sibling imports:** `pnpm knip` reports unused exports (it counts a name used only inside its own file as unused outside `packages/cli`, which alone has `ignoreExportsUsedInFile`). Facade re-exports count as use; the `@public` JSDoc tag (as on `FoundationRegistries`, `foundation.ts:21-24`) is the existing escape hatch for names kept only for declaration emit.
- **Defining the counter in one module and `serve` in another:** forbidden by TEST-03; also avoid a live `export let` read across modules.
- **Retyping or reflowing moved code:** this repo has `typescript/consistent-type-assertions: never` in `packages/*/src` and "no return-type annotations on new Effect/Layer consts" (IMPLEMENTING.md); move verbatim so neither rule is newly triggered.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| "Is the surface identical?" | A hand-diff of `grep '^export'` (the milestone PITFALLS suggestion) | The compiler-API probe above plus the runtime key pin | `grep` misses overload sets, types behind re-exports and `export {}` lists (47 names, 12 of which are re-exports) |
| Cycle detection | A manual import review | `pnpm circular` | Counts type-only imports (`scripts/circular.mjs` two-pass) |
| Declaration-emit portability | Hand-written type annotations to dodge TS2883 | Keep `Provided`/`Requires`/`TestProvided` in the same module as `layer` | The comment at `TestAuth.ts:280-281` records why; same-module placement preserves it |
| Spec revision bookkeeping | Editing the Revision cell only | Revision + Effective Date + Change History row together | `check-drift.mjs` check 14 fails if the cell and newest row differ |

**Key insight:** this is a verbatim move plus import surgery. Every decision beyond placement (rename, retype, dedupe) is out of scope and is a surface-change risk.

## Module-level mutable state and closure coupling (item 3)

| Item | Where | What a naive move breaks | Handling |
|------|-------|--------------------------|----------|
| `let openAppCount = 0;` | `TestAuth.ts:626` | Counter incremented in `make` (`openAppCount++;` 662, in `Effect.sync` at acquire) and decremented in `release` (`openAppCount--;` 760); read by `export const openApps = () => openAppCount;` 627. Exactly 4 occurrences in the repo [VERIFIED: `grep -rn "openApps\|openClients\|openAppCount"` over `*.ts`] | Move `openAppCount`, `openApps`, `make`, `serve`, `listen`, `withApp` together into `appHarness.ts`. Post-move check: `grep -c openAppCount packages/test/src/internal/appHarness.ts` = 4 and the string occurs in no other file. |
| `TestSql.openClients` | `packages/test/src/TestSql.ts:125` (`export const openClients = () => open;`) | Not in `TestAuth.ts`; the SQL composition acquires its client via `TestSql.layer(options.suite)` in `makeLayer` (355) | Untouched; keep calling `TestSql.layer` from composition |
| Module-init Layer constants | `TestHasher` (138), `GuardLive` (214), `httpClient.*` layers (956-972), `TestCsrfConfig` (221) | Layer identity feeds memoization: a second copy would build twice (and `TestCsrfConfig` is read by the BDD step `TestingHarnessComposeSteps.ts:81`: `Layer.succeed(Csrf.CsrfConfig, TestAuth.TestCsrfConfig)`) | Define each exactly once, in one module; facade only re-exports |
| Per-call closures | `make` closes over `signInAs`, `csrfSetCookie`, `withRequest`, `withoutRequest`; `runPluginContractTests` closes over `previousContract` (1423) inside `describe`, not module level | Mis-scoping `previousContract` to module level would leak state across `runPluginContractTests` calls | Move the function body verbatim; no module-level `let` exists besides `openAppCount` [VERIFIED: grep for `^let `/`^var ` in TestAuth.ts shows only 626] |
| Env read at call time | `process.env["AWTHAQ_POSTGRES_URL"]` (1582) inside the runner | Hoisting it to module scope would freeze it at import time | Keep it inside the `describe` callback |
| Import-time effects | None: package.json has `"sideEffects": false`; every top-level statement is a pure constant or function | Evaluation order between the new modules does not matter | n/a |

## Consumers (item 4)

- **Imports of `TestAuth.*`:** everything outside the package imports `{ TestAuth } from "@awthaq/test"` (organization `Contract.test.ts:5`, `OrganizationHooks.test.ts:24`, every `features/step-definitions/*World.ts`, examples, `Schema.lock.test.ts` x13). [VERIFIED: grep]
- **Deep imports of the file:** the only importers of `packages/test/src/TestAuth.ts` by path are inside the package: `packages/test/src/index.ts:13` and 21 files in `packages/test/test/` (`import * as TestAuth from "../src/TestAuth.ts"`, e.g. `TestAuthLifetime.test.ts:7`, `MemoryFoundation.test.ts:10`, `RecordsContract.types.test.ts:17`). They keep working because the facade keeps its path. No file outside `packages/test` imports it by path. [VERIFIED: grep for `TestAuth\.ts` and `@awthaq/test/src` over the repo]
- **Config naming the file:** none. `packages/test/package.json` exports only `.` (lines above); `packages/test/tsconfig.src.json` has `"include": ["src/**/*.ts"]` (new `internal/*.ts` files are picked up automatically); `knip.json` has no `packages/test` entry (workspaces: `.`, `ports`, `cli`, `migrate-better-auth`, `features`); `.oxlintrc.json`, `.oxfmtrc.json`, `vitest.config.ts` do not name it; `scripts/*.mjs` do not name it (`check-contract-tests.mjs` only checks that no `packages/*/src` outside `packages/test` imports `@awthaq/test` and that `package.json` `dependencies` omit it). [VERIFIED: read each]
- **Source-text census tests that DO name the file (the finding that contradicts "no edit outside packages/test"):**

| File | Line | Literal | Pattern and pinned count | Moves to |
|------|------|---------|--------------------------|----------|
| `packages/core/test/SignInSeams.test.ts` | 81 | `file: "test/src/TestAuth.ts",` `count: 1`, why "signInAs mints a session for an authorization test, with no credential involved" | `/\bsessions\s*\.issue\(/g` (inside `signInAs`) | `test/src/internal/session.ts` |
| `packages/core/test/SignInSeams.test.ts` | 138 | `file: "test/src/TestAuth.ts",` `count: 1`, why "signInAs fixes a user for an authorization test, with no sign-up policy involved" | `/\busers\s*\.(create\|createOrGet\|createWith)\(/g` (inside `signInAs`) | `test/src/internal/session.ts` |
| `packages/core/test/RequestContextSeams.test.ts` | 99 | `file: "test/src/TestAuth.ts",` `count: 2`, why "the harness's fixed `clientAddress` resolver (a port layer, not a read)" | `/\bClientAddress\.ClientAddress\b/g` (`fixedClientAddress`, `TestAuth.ts:187-188`) | `test/src/internal/composition.ts` |
| `packages/core/test/RequestContextSeams.test.ts` | 178 | `file: "test/src/TestAuth.ts",` `count: 1`, why "TestAuth.withoutRequest, the harness's explicit absence" | `/AuthRequestContext\.noRequest/g` (`withoutRequest`, `TestAuth.ts:212`) | `test/src/internal/session.ts` (if `withRequest` stays with `signInAs`) |

  Mechanism [VERIFIED: read `RequestContextSeams.test.ts:1-60`]: the test reads every `packages/*/src/**/*.ts`, drops comment-only lines, counts matches per file keyed `relative(packagesDir, path)`, and `assert.deepStrictEqual(found, expected)`. After the split these four entries fail (`found` lists the new path, `expected` the old). Edit only the `file:` literals (and the `why` strings may stay). Each of the 4 edits must land in the same commit as the extraction that moves the matched code, or `pnpm test` is red between commits. Both tests currently pass: `npx vitest run --project core packages/core/test/SignInSeams.test.ts packages/core/test/RequestContextSeams.test.ts` -> 2 files, 17 tests passed.
  No other source-census test is affected: `PasswordCredentialSeams.test.ts`, `organization/test/RecordsBoundary.test.ts`, `AuthorizationBoundary.test.ts`, `OrganizationHooks.test.ts` scan `packages/*/src` but contain no `test/src` key. [VERIFIED: grep `test/src` across `packages/*/test`: only these two files name `test/src/TestAuth.ts`]
- **Other mentions (no edit needed):** `.plan/**`, `.scratch/**`, `.planning/**`, `expert-audit-dashboard.html` mention `TestAuth.ts` as history; knip ignores `.scratch/**` and none of these is verified by a gate. `features/features/08-tooling/25-testing-harness.feature:68` says "(TestAuth.ts header)": remains true because the header stays in the facade. `docs/plugin-authoring.md` and `packages/test/README.md` name `TestAuth.<name>` only, never the file path.

## LeakGuard, `openApps`/`openClients` and `Schema.lock` (item 6)

- `features/step-definitions/shared/LeakGuard.ts` is a vitest `setupFiles` entry (`features/vitest.config.ts:33`); its `afterAll` polls `TestAuth.openApps() > 0 || TestSql.openClients() > 0` up to `SETTLE_MS = 10_000`, then throws `[leak-guard] <file> apps=<n> sqlClients=<n>` unless `AWTHAQ_LEAK_GUARD=report`. It reads `TestAuth.openApps` through `@awthaq/test`.
- Counter-pinning tests (all in `packages/test/test`, importing `../src/TestAuth.ts`): `TestAuthLifetime.test.ts` (serve releases on scope end, failure and interruption: `assert.strictEqual(TestAuth.openApps(), apps + 1)` then back to `apps`; `withApp` resolve and reject paths), `TestAuthLazy.test.ts:25-81` (`lazyApp` build/replace changes `openApps` by exactly 1), `TestAuthListen.test.ts:38,57`; plus BDD `features/step-definitions/TestingHarnessComposeSteps.ts:227-234` (`appsDelta`).
- `Schema.lock.test.ts`: **12 files under `packages/*/test/`** (`admin, api-key, device-authorization, jwt, organization, passkey, qadi, roles, saml, scim, two-factor, webhooks`) plus a 13th under `examples/plugin-template/test/`. Each is `const locked = await TestAuth.migratedSchema(<Plugin>); await expect(JSON.stringify(locked, null, 2)).toMatchFileSnapshot("schema.sqlite.json");`. They depend only on the shape `{ migrations, schema: { tables, indexes, triggers } }` returned by `migratedSchema` (`TestAuth.ts:1160-1184`), which comes from `TestSql.schemaOf` (`TestAuth.ts:1152`, inside `applyMigrationsOn`, 1116-1154).
- What could change them: only altering `migratedSchema`/`applyMigrations*` behaviour (statement order, `Effect.all` pairing, the double `Migrations.run` ritual at 1149-1150) or severing the `applyMigrations -> applyMigrationsOn -> TestSql.schemaOf` chain. Move the three functions together, verbatim, into `contractRunner.ts`. A snapshot diff in any `schema.sqlite.json` is the signal; vitest's `toMatchFileSnapshot` would fail rather than write in CI mode (never run with `--update`).
- TEST-02 wording note: the roadmap says `migratedSchema` "still calls `TestSql.schemaOf`"; literally it calls `applyMigrations`, which calls `applyMigrationsOn`, which calls `TestSql.schemaOf`. Verify with `grep -n "TestSql.schemaOf" packages/test/src/internal/contractRunner.ts` (one hit) plus the 13 Schema.lock runs.

## Barrel-plus-`internal/` precedent (item 7)

- `internal/foundation.ts` (63 lines): imports `../TestEncryption.ts` (siblings are reached with `../X.ts`), exports `FoundationRegistries` with `@public` JSDoc ("Named so the foundation's inferred type can be emitted"), `memoryFoundation`, `recordsFoundation`. Its header: "shared by `TestAuth` and `RecordsContract` ... without either importing the other". Re-exported from the facade by `export { memoryFoundation } from "./internal/foundation.ts";` (`TestAuth.ts:160`). `RecordsContract.ts:43` imports `recordsFoundation` from it.
- `internal/contract.ts` (84 lines): verdict machinery shared by `StoreContract.ts:43` and `RecordsContract.ts:42`.
- `internal/storeContract/*.ts` (9 files, `suite.ts`, `users.ts`, ...): imported one by one by `StoreContract.ts:44-51` and re-exported in part (`StoreContract.ts:56: export { type Suite, suite } from "./internal/storeContract/suite.ts";`). Note the siblings `StoreContract.ts` and `RecordsContract.ts` keep their runner logic in the top-level file and put shared helpers in `internal/`; `TestAuth.ts` will be the first top-level file that is a pure facade, so there is no exact precedent for a facade-only file beyond the `TestAuth.ts:1858-1869` re-export block. Use that block's style.
- Style rules visible in the existing code: explicit `.ts` extensions in relative imports (`allowImportingTsExtensions`, `rewriteRelativeImportExtensions`); `import type` for type-only (`verbatimModuleSyntax`); a header comment per file naming the plan/ADR (`// @awthaq/test — the memory foundation, ...`); `effect/*` imported by deep path (`import * as Layer from "effect/Layer"`), enforced by `effect/no-import-from-barrel-package` in `.oxlintrc.json`.

## Spec citations and Document Control (item 5)

Citations to change [VERIFIED: grep and read this session]:

| File:line | Today | After (recommended) |
|-----------|-------|---------------------|
| `spec/behaviors/25-testing-harness.md:313` (BEH-EA-342, `TestAuth.layer` over test ports) | `*Implementation* (`packages/test/src/TestAuth.ts`; `test/TestAuthHost.test.ts`, run on Postgres under `pnpm test:pg`; `test/TestAuthRecords.types.test.ts` for the foreign tap; `packages/admin/test/AdminTier.test.ts` for the public tier).` | `packages/test/src/internal/composition.ts` (re-exported by `TestAuth.ts`); keep all test names |
| `spec/behaviors/25-testing-harness.md:336` (BEH-EA-351 `serve`/`withApp`) | `*Implementation* (`packages/test/src/TestAuth.ts`; `test/TestAuthLifetime.test.ts`). `TestAuth.app` stays as a deprecated adapter until plan 34 ticket 21.` | `packages/test/src/internal/appHarness.ts`; leave the `TestAuth.app` sentence alone (stale since 1.12, out of scope) |
| `spec/behaviors/25-testing-harness.md:356` (BEH-EA-352 `lazyApp`) | `*Implementation* (`packages/test/src/TestAuth.ts`; `test/TestAuthLazy.test.ts`).` | `appHarness.ts` |
| `spec/behaviors/25-testing-harness.md:372` (BEH-EA-353 `listen`) | `*Implementation* (`packages/test/src/TestAuth.ts`; `test/TestAuthListen.test.ts`).` | `appHarness.ts` |
| `spec/behaviors/25-testing-harness.md:59` and `:95` | "as `TestAuth.ts` documents" / "(see also `TestAuth.ts`'s header)" | No change if the header stays in the facade (recommended) |
| `spec/traceability.md:51` (file 25 row, last cell) | `@awthaq/test/src/TestAuth.ts` (agents: `@awthaq/web/src/UserAgent.ts`; BEH-EA-336's record-store suites: `@awthaq/test/src/RecordsContract.ts`) | `@awthaq/test/src/TestAuth.ts` (the facade) over `@awthaq/test/src/internal/{composition,session,appHarness,contractRunner}.ts` (agents ...; record-store suites ... unchanged) |
| `spec/traceability.md:336` (`TestAuthLifetime.test.ts` row, `| \`@awthaq/test/src/TestAuth.ts\` |`) | `@awthaq/test/src/TestAuth.ts` | `@awthaq/test/src/internal/appHarness.ts` |
| `spec/traceability.md:337` (`TestAuthLazy.test.ts`) and `:338` (`TestAuthListen.test.ts`) | same | `@awthaq/test/src/internal/appHarness.ts` |
| `spec/invariants.md:189` (INV-EA-016 Enforcement: "`runPluginContractTests` (`packages/test/src/TestAuth.ts`, \"every declared table carries this plugin's own id prefix\"; ...)") | not in CONTEXT's list | recommended: `packages/test/src/internal/contractRunner.ts` (the check lives there after the split). Check 10 (`check-drift.mjs:86-112`) verifies backticked `packages/...` paths in `invariants.md` and `traceability.md` exist, so the new path must exist; the old one will still exist, so skipping this edit passes the gate but leaves a citation that no longer locates the check |

Document Control state (each touched file's Revision must equal its newest Change History row; check 14, `check-drift.mjs:203-225`, regex `\|\s*Revision\s*\|` and `\|\s*Change History\s*\|(.*)\|\s*$`, versions `(\d+\.\d+)\s*\(`):

| File | Revision now | Newest Change History row now | Bump to | Effective Date now |
|------|--------------|-------------------------------|---------|--------------------|
| `spec/behaviors/25-testing-harness.md` (header line 7 `> | Revision | 1.15 |`) | 1.15 | `1.15 (2026-11-10): BEH-EA-357 ...` | 1.16 | 2026-11-09 |
| `spec/traceability.md` (line 8 `> | Revision | 1.89 |`) | 1.89 | `1.89 (2026-11-14): \`PluginViews.test.ts\` row ...` | 1.90 | 2026-11-14 |
| `spec/invariants.md` (line 8 `> | Revision | 1.9 |`) | 1.9 | `1.9 (2026-11-13): INV-EA-013's Enforcement ...` | 1.10 (only if line 189 is edited) | 2026-11-13 |

Format: Phase 1 did exactly this in commit `ffe1e99f` for `26-cli.md` (Revision 1.9 -> 1.10, Effective Date -> `2026-11-14`, one new ` <br> 1.10 (2026-11-14): ...` Change History row, `*Implementation*` lines reworded). Table lines are prefixed `> `, so match on that form when editing. Append the new row at the END of the Change History cell (the cell ends with ` |`).

Other spec checks that read implementation paths: only check 10 (above, `invariants.md` and `traceability.md` only, backticked `packages|examples|features/...` paths). The `@awthaq/test/src/...` form used on `traceability.md:51,336-338` is NOT matched by check 10's regex (`PATH = /`((?:packages|examples|features)\/...`), so a typo there would pass the gate silently: the plan must verify each new cited path with `test -f`. Checks 9, 11-13, 15-19 do not read these files' paths. `check-drift.mjs` check 17 (spec/README.md BEH range) is untouched. If the new `TestAuthSurface.test.ts` is worth documenting, add it to the `traceability.md` §5 test table (the Revision bump covers it).

## Common Pitfalls

### Pitfall 1: The two core census tests turn red (planned-for, not a surprise)
**What goes wrong:** `pnpm test` fails in `packages/core/test/SignInSeams.test.ts` and `RequestContextSeams.test.ts` with `found {...test/src/internal/session.ts...}` vs `expected {...test/src/TestAuth.ts...}`.
**Why:** they pin per-file counts of `sessions.issue(`, `users.create(`, `ClientAddress.ClientAddress`, `AuthRequestContext.noRequest`.
**How to avoid:** edit the four `file:` literals in the commit that moves each construct (table above); run both files after every extraction.
**Warning signs:** `assert.deepStrictEqual` diff naming `test/src/internal/...`.

### Pitfall 2: Facade leaks an internal helper (`export *` or a stray named export)
**What goes wrong:** `makeLayer` (or `TestHasher`) becomes `TestAuth.makeLayer`: the name set differs.
**How to avoid:** named re-exports only; `Object.keys(TestAuth).sort()` pin; probe diff.

### Pitfall 3: Counter split from `serve`
**What goes wrong:** `openApps()` reads a different counter than `make` writes (or a duplicated module instance); leak guard passes vacuously or fails every feature file.
**How to avoid:** one module owns `openAppCount`, `openApps`, `make`; assert `grep -c openAppCount appHarness.ts` = 4 and zero elsewhere; run `TestAuthLifetime`, `TestAuthLazy`, `TestAuthListen`, then `pnpm test:bdd` after `tsc -b` (the BDD suite resolves `@awthaq/test` through the built `lib/`, per Phase 1 baseline notes).

### Pitfall 4: Declaration emit / TS2883 on moved inferred types
**What goes wrong:** `tsc -b` errors "inferred type cannot be named" when an exported const's inferred type references a non-exported type from another module.
**Why:** the file's own comments flag it (`TestAuth.ts:149`, `:281`). `declaration: true` and no `isolatedDeclarations`.
**How to avoid:** keep `testPorts`, `TestProvided`, `Guarded`, `GuardIn`, `Provided`, `Requires`, `makeLayer` and `layer` in one module; `RetentionRegistryService`/`FoundationServices` go to `foundation.ts` beside `FoundationRegistries`; run `tsc -b` after each extraction. `layer`'s two overloads must move together with the implementation signature.

### Pitfall 5: Unused imports and unused exports
**What goes wrong:** `noUnusedLocals` errors (TS6133) in the facade or new modules; `pnpm knip` reports exports nobody imports.
**How to avoid:** trim `TestAuth.ts` imports to nothing (it re-exports only); export from `internal/` only what a sibling or the facade imports; `makeLayer` is imported by the contract runner so it is a used export.

### Pitfall 6: Cycle through types
**What goes wrong:** `pnpm circular` pass 2 (type-inclusive) fails if any `internal/` file imports `../TestAuth.ts` even with `import type`.
**How to avoid:** none of the new modules needs anything from the facade (verified above); import `TestFramework` from `../TestFramework.ts`.

### Pitfall 7: Header drift
**What goes wrong:** the facade's header says "`RateLimiter.layerPermissive` is wired in below" (`TestAuth.ts:6-7`), but nothing is below any more.
**How to avoid:** reword to name `internal/composition.ts`; keep the rest of the header (spec cites it).

### Pitfall 8: Committing the probe script
Covered under "Knip trap".

## Code Examples

Facade shape (verbatim style of the existing re-exports at `TestAuth.ts:158-160` and `1858-1869`; names are the 47 listed above):

```ts
// TestAuth.ts — header comment kept (spec 25 lines 59 and 95 cite it)
export {
  TestCsrfConfig, encryption, httpClient, layer, recordModes,
} from "./internal/composition.ts";
export type { CommonOptions, MemoryMode, SqlMode } from "./internal/composition.ts";
export {
  csrfSetCookie, csrfToken, sessionSetCookie, signInAs, withRequest, withoutRequest,
} from "./internal/session.ts";
export type { SignedInSession } from "./internal/session.ts";
// ... appHarness, contractRunner, foundation as listed; then the existing lines:
export type { TestFramework } from "./TestFramework.ts";
export { runSealedColumnTests } from "./SealedConformance.ts";
// (sealed/tenant re-exports unchanged)
```

Counter co-location after the move (all four occurrences in `internal/appHarness.ts`):

```ts
let openAppCount = 0;                         // was TestAuth.ts:626
export const openApps = () => openAppCount;   // was TestAuth.ts:627
// in make(): openAppCount++;  (was 662)    in release(): openAppCount--;  (was 760)
```

Runtime key pin (Wave 0, green before and after):

```ts
import { assert, it } from "@effect/vitest";
import * as TestAuth from "../src/TestAuth.ts";
it("the TestAuth value surface is exactly these names", () => {
  assert.deepStrictEqual(Object.keys(TestAuth).sort(), [/* the 23 value names, sorted, copied from the BEFORE run */]);
});
```

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| `typescript` compiler API for surface dumps | Not available on TS 7 (`typescript@7.0.2` exposes no program API from `require`) | Use the transitive TS 5.9.3 probe or runtime/type pins |
| `.planning/IMPLEMENTING.md`: "`pnpm knip` fails ONLY because of ~101 `.reports/` files" | Superseded by `01-BASELINE.md`: 39 unused `.claude/` files + 3 unlisted deps in `packages/sql/test/fixtures/readme-quickstart.ts` | Use the filtered-knip rule from the baseline |
| Milestone research "prune `buildContext` and `openApps`" (ARCHITECTURE.md:165) | Overruled by CONTEXT: `buildContext` stays; `openApps` is used by `LeakGuard.ts` | Do not prune |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Editing the four `file:` literals in `packages/core/test/SignInSeams.test.ts` and `RequestContextSeams.test.ts` is compatible with "no consumer file outside `packages/test` needs an edit" because those tests read source text and import nothing | Consumers, Open Question 1 | If the user reads the criterion literally, the phase needs a different design (there is none that keeps the counted constructs in the facade) or an explicit waiver |
| A2 | File names `composition.ts`, `session.ts`, `appHarness.ts`, `contractRunner.ts` | Layout | Cosmetic; census/spec citations must follow whatever is chosen |
| A3 | `withRequest`/`withoutRequest` belong in `session.ts` (not a fifth module) | Coupling table | Mild naming mismatch; moving to a fifth module later touches the census (`withoutRequest` count) and spec cites |
| A4 | `RetentionRegistryService`/`FoundationServices` belong in `internal/foundation.ts` | Section map | If placed in composition instead nothing breaks; only locality differs |
| A5 | No changeset is needed (surface identical, no `Migration:`; GATE-03 applies to "package-visible" changes) | Gates | If the user wants every touched published package to carry a changeset, add a patch one for `@awthaq/test` (repo uses a `fixed` release group, so a patch bumps the whole group) |
| A6 | `typescript@5.9.3` stays in the pnpm store for the duration of the phase | Surface snapshot | Fall back to the runtime pin + `tsc` checks; no repo change needed |
| A7 | Editing `spec/invariants.md:189` (and bumping its Revision) is in scope although CONTEXT lists only two spec files | Spec citations | If out of scope, the citation still resolves (old file exists) but points at the facade, not where the check lives |

## Open Questions

1. **The census tests outside `packages/test` (needs the user's call before planning is final).**
   - Known: two core tests pin per-file counts by the path `test/src/TestAuth.ts`; the split necessarily moves four matched constructs; editing four string literals fixes it; surface and consumers are untouched.
   - Unclear: whether the user counts this as violating "no consumer file outside `packages/test` may need an edit".
   - Recommendation: treat it as the one named exception (edit only the four `file:` literals, same commits as the moves) and say so in the plan and the phase summary. The acceptance check for criterion 1 becomes: `git diff --name-only <base>..HEAD` contains only `packages/test/**`, `packages/core/test/SignInSeams.test.ts`, `packages/core/test/RequestContextSeams.test.ts`, `spec/**`, `.planning/**`.
2. **Changeset or none** (A5). Recommendation: none; record the reason in the summary.
3. **Edit `spec/invariants.md:189`** (A7). Recommendation: yes, with Revision 1.9 -> 1.10, because the check it names moves.
4. **Is the 12 vs 13 `Schema.lock.test.ts` count a problem?** 12 under `packages/*/test`, plus `examples/plugin-template/test/Schema.lock.test.ts`. The root vitest `projects` include `examples/plugin-template`, so `pnpm test` runs all 13; none needs an edit.

## Runtime State Inventory

Not a rename/migration phase in the data sense (no stored strings, services, OS registrations or secrets embed the file name). Explicit answers:
- Stored data: none (verified: no datastore keys reference `TestAuth.ts`).
- Live service config: none.
- OS-registered state: none.
- Secrets/env vars: none renamed. `AWTHAQ_POSTGRES_URL` and `AWTHAQ_LEAK_GUARD` are read by name inside the moved code; names unchanged.
- Build artifacts: `packages/test/lib/` is gitignored (`.gitignore:2: lib/`) and is regenerated by `tsc -b`; the BDD suite and `package:smoke` read it, so run `npx tsc -b tsconfig.json` before them (stale `lib/TestAuth.js` is overwritten; new `lib/internal/*.js|d.ts` are added; nothing is removed).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| node | all gates | yes | v26.13.0 | — |
| pnpm | all gates | yes | 11.20.0 | — |
| `typescript` (tsgo) | `tsc -b` | yes | 7.0.2 | — |
| `typescript@5.9.3` (transitive, store only) | surface probe | yes (`node_modules/.pnpm/typescript@5.9.3`) | 5.9.3 | runtime key pin + `tsc` checks |
| Postgres (`AWTHAQ_POSTGRES_URL`) | `pnpm test:pg`, Postgres-gated cases | no (`PG=unset`) | — | record "not run locally"; this phase changes no SQL behaviour, but `TestAuthHost.test.ts` (cited by spec) and the contract runner's Postgres parity case run only under it |

Missing with no fallback: none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 5.0.2 with `@effect/vitest` (`it`, `it.effect`, `assert`) |
| Config file | root `vitest.config.ts` (`projects: ["packages/*", "examples/plugin-template", ...]`); `packages/test/vitest.config.ts` (`name: "test"`, `include: ["test/**/*.test.ts"]`) |
| Quick run command | `npx vitest run --project test` (measured: 33 files, 627 passed, 1 expected fail, ~12 s wall) |
| Census quick run | `npx vitest run --project core packages/core/test/SignInSeams.test.ts packages/core/test/RequestContextSeams.test.ts` (measured: 17 passed, under 1 s) |
| Full suite command | `pnpm test` (Phase 1 close: 410 files passed, 4 skipped; 6484 passed, 1 expected fail, 15 skipped) |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TEST-01 | Exported name set identical | probe diff + runtime pin + typecheck | `diff 02-SURFACE-BEFORE.txt 02-SURFACE-AFTER.txt`; `npx vitest run --project test packages/test/test/TestAuthSurface.test.ts`; `npx tsc -b tsconfig.json && npx tsc -p tsconfig.test.json` | Wave 0 (pin test and BEFORE file do not exist) |
| TEST-01 | Four modules under `internal/`, facade only re-exports | structural check | `ls packages/test/src/internal/{composition,session,appHarness,contractRunner}.ts`; `grep -c "^export \*" packages/test/src/TestAuth.ts` = 0; `pnpm circular` | after implementation |
| TEST-01 | No file outside the allowlist edited | diff check | `git diff --name-only <phase-base>..HEAD` only under `packages/test/`, the two core census files, `spec/`, `.planning/` | after implementation |
| TEST-02 | `buildContext` exported; `migratedSchema` reaches `TestSql.schemaOf` | unit | `npx vitest run --project test packages/test/test/TestAuthApp.test.ts` (the `buildContext` case at line 225); the 13 `Schema.lock` tests via `pnpm test`; `grep -n "TestSql.schemaOf" packages/test/src/internal/contractRunner.ts` = 1 hit | exists |
| TEST-03 | Counter beside `serve`/`openApps`, accounting unchanged | unit + BDD | `npx vitest run --project test packages/test/test/TestAuthLifetime.test.ts packages/test/test/TestAuthLazy.test.ts packages/test/test/TestAuthListen.test.ts`; `grep -rc openAppCount packages/test/src` (4 in `appHarness.ts`, 0 elsewhere); `pnpm test:bdd` (LeakGuard `afterAll`) | exists |
| TEST-04 | Spec cites new locations, test names kept, strict verify passes | spec gate | `pnpm spec:verify:strict` (PASS 32 / FAIL 0); `grep -rn "src/TestAuth.ts" spec` lists only intended facade mentions; `test -f` for each newly cited path | exists |

### Sampling Rate
- **Per extraction commit:** `npx tsc -b tsconfig.json && npx vitest run --project test && npx vitest run --project core packages/core/test/SignInSeams.test.ts packages/core/test/RequestContextSeams.test.ts`
- **Per wave merge:** add `npx tsc -p tsconfig.test.json`, `pnpm circular`, `pnpm lint`, `pnpm format:check` (run `npx oxfmt <new files>` first; oxfmt ignores `spec`, `docs` and `**/*.md`), `pnpm check:contract-tests`
- **Phase gate:** the full Phase 1 list below, compared with the Phase 1 CLOSE numbers (below)

### Gate list for phase close (reuse Phase 1; baseline to compare against is Phase 1's close table, `01-04-SUMMARY.md`, same worktree)
| Gate | Command | Expected at Phase 2 close |
|------|---------|---------------------------|
| tsc -b | `npx tsc -b tsconfig.json` | exit 0, no output |
| tests typecheck | `npx tsc -p tsconfig.test.json` | 0 `error TS` (2 pre-existing `warning TS377149` in `TestingHarnessSteps.ts`) |
| circular | `pnpm circular` | exit 0 |
| error tags | `pnpm check:error-tags` | `163 internal and 137 wire error tags, none shared` |
| transactions | `pnpm check:transactions` | exit 0 |
| lint | `pnpm lint` | warnings only (87 `.claude/`, 7 `RequestContextSteps.ts`), no errors, none in new files |
| format | `pnpm format:check` | exit 0 (1205 files at P1 close; new files add to the count, e.g. +5 `src`/`test` files) |
| readmes / workspace | `pnpm check:readmes`, `pnpm workspace:check` | exit 0 |
| contract tests (phase-specific addition; part of `pnpm check`, not in Phase 1's baseline) | `pnpm check:contract-tests` | exit 0 |
| bdd | `pnpm test:bdd` (after `tsc -b`) | 39 files, 1576 passed, 44 skipped (counts may not shrink) |
| unit | `pnpm test` | at least 410 files / 6484 passed, 1 expected fail, 15 skipped (+1 file, +1 test for the surface pin) |
| coverage | `pnpm coverage` | at or above 91.65 / 85.08 / 86.9 / 92.17; floors 89 / 83 / 84 / 90 (moved lines are unchanged lines, so no drift expected) |
| spec | `pnpm spec:verify:strict` | PASS 32 FAIL 0 |
| knip | `pnpm knip 2>&1 \| grep -v '^\.claude/' \| grep -v '^\.reports/'` | only the banner, the two headings, the 3 `readme-quickstart.ts` rows and `[ELIFECYCLE]`; `git diff --stat knip.json` empty. Phase-specific: no new "Unused exports" or "Unused files" row for `packages/test/src/internal/*` |
| package smoke | `pnpm package:smoke` (after `pnpm clean && pnpm build` or `tsc -b`) | PASS for 30 packages; the new `lib/internal/*.d.ts` must resolve under publint/attw |
| Postgres | `pnpm test:pg` | not run locally (`AWTHAQ_POSTGRES_URL` unset); skipped inside counts |

### Wave 0 Gaps
- [ ] `02-SURFACE-BEFORE.txt` (probe output, 47 names) and the probe script text kept in the plan (not committed as `.cjs`: knip)
- [ ] `packages/test/test/TestAuthSurface.test.ts` (runtime key pin of the 23 values), green before any `src` change
- [ ] Optional `TestAuthSurface.types.test.ts` (24 type names)
- [ ] Re-record `packages/test` project baseline: 33 files, 627 passed, 1 expected fail; and the two census tests: 2 files, 17 passed
- [ ] No framework install needed

## Security Domain

Applicable ASVS level 1 view: this phase moves test-harness code; it adds no endpoint, secret, dependency or runtime behaviour. Nothing security-relevant may change.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (harness mints sessions for tests only) | n/a |
| V3 Session Management | indirectly: `signInAs` issues a real session via `Sessions.issue` and renders the cookie under `SessionCookieConfig` | Move verbatim; the census test pins that `sessions.issue(` appears once, in `signInAs` |
| V5 Input Validation | no | n/a |
| V6 Cryptography | yes (test-only): `csrfToken` uses `createHmac("sha256", key)` and `randomBytes(32)` from `node:crypto`, independent of `Csrf.ts` (`TestAuth.ts:505-507`) | Never hand-roll; keep the independent computation exactly (it is how a passing request proves RFC 2104 compatibility) |
| V7 Error handling and logging | yes: redaction guard | `GuardLive` (`TestAuth.ts:214`) is merged into every composition's `decorate` slot (`Layer.provideMerge(GuardLive)`, 332); dropping that merge silently disables the EOTS-002 "no `Redacted` value or canary reaches a span, log or event" check |
| V14 Configuration | yes: test-only constants | see below |

### Security-relevant items and the no-change rule
- `TestCsrfConfig` is test-only: `secret: Redacted.make("test-auth-csrf-secret-padded-to-at-least-thirty-two-bytes")`, `allowedOrigins: []` (`TestAuth.ts:221-224`); it is a fixture, not a production secret. Keep value and `Redacted` wrapping.
- `TestHasher`: real argon2id with `AUTH_ARGON2_MEMORY_KIB: "1024", AUTH_ARGON2_ITERATIONS: "1"` (`TestAuth.ts:142`), `Layer.orDie`. Keep.
- `RateLimiter` default permissive; `"enforcing"` swaps in `RateLimiter.layerMemory` (170-182). `AuthEvents.UndeclaredEventPolicy` is `"die"` (342). Keep both.
- Redaction guard and canaries: `RedactionGuard.layer` + `layerEvents` (214), the runner's redaction case (1804-1834, `redaction.exercise(guard)`, `guard.assertNoLeaks`). A move that drops the guard from `makeLayer` would pass every test that does not use a canary; the detection is `packages/test/test/runPluginContractTests.test.ts` (redaction case driven with a canary password, per the spec's traceability row).
- Surface hygiene: do not re-export `makeLayer` or any internal helper (smaller attack/misuse surface for third-party plugin authors who run this package).

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| A refactor silently drops the redaction guard or the `UndeclaredEventPolicy "die"` provision from `makeLayer` | Information disclosure / Tampering | Move `makeLayer` as one unit; keep `runPluginContractTests.test.ts` and `TestAuthHost.test.ts` green |
| Test-only weakened hasher or fixed CSRF secret leaking into a production export | Elevation of privilege | Package is dev-only: `check-contract-tests.mjs` fails if any `packages/*/src` outside `packages/test` imports `@awthaq/test` or lists it under `dependencies` |
| Surface widening (internal helper becomes public API) | Tampering | Named re-exports; runtime key pin; probe diff |

## Sources

### Primary (HIGH confidence, read or executed in this worktree)
- `packages/test/src/TestAuth.ts` (all 1869 lines), `packages/test/src/index.ts`, `packages/test/src/internal/foundation.ts`, `internal/contract.ts`, `StoreContract.ts` head, `packages/test/package.json`, `tsconfig.src.json`, `tsconfig.base.json`, root `vitest.config.ts`, `packages/test/vitest.config.ts`, `knip.json`, `.oxlintrc.json`, `.changeset/config.json`
- `packages/core/test/SignInSeams.test.ts`, `RequestContextSeams.test.ts`; `features/step-definitions/shared/LeakGuard.ts`; `packages/test/test/TestAuthLifetime.test.ts`; `packages/*/test/Schema.lock.test.ts` (read `roles`)
- `spec/behaviors/25-testing-harness.md`, `spec/traceability.md`, `spec/invariants.md`, `spec/scripts/verify-traceability.sh`, `spec/scripts/check-drift.mjs` (checks 10 and 14), `scripts/circular.mjs`, `scripts/check-contract-tests.mjs`
- Phase 1: `01-BASELINE.md`, `01-04-SUMMARY.md` (close table), `01-VALIDATION.md`; commit `ffe1e99f` (spec revision format)
- Runs: `npx vitest run --project test` (627 passed, 1 expected fail), census pair (17 passed), probe (47 names, deterministic); `npx tsc -v` (7.0.2); `node --version` v26.13.0; `pnpm --version` 11.20.0

### Secondary / Tertiary
- None. `.planning/research/ARCHITECTURE.md` and `PITFALLS.md` were consulted only as leads: their `grep` counts were re-verified above; their "prune `buildContext`/`openApps`" suggestion is overruled by CONTEXT; they did not mention the census tests.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, nothing new
- Architecture (modules, DAG, coupling): HIGH, derived by line-level reading plus an identifier scan; the import table is a scan (use `tsc -b` as the arbiter)
- Pitfalls: HIGH for the census finding, counter, facade leaks, knip; MEDIUM for declaration-emit behaviour after the move (reasoned from the file's own TS2883 comments and same-module placement, not yet exercised)

**Research date:** 2026-11-14
**Valid until:** until `packages/test/src/TestAuth.ts` or the two census tests change (about 30 days otherwise); line numbers are for HEAD `34a223ca`
