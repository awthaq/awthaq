# Phase 2 Gate Baseline

**HEAD at capture:** `dce2dff5fe16f0b98b67628f1c33cb828ad2aa94` (branch `architecture/deepening-batch-3`)
**Captured:** 2026-11-14, on a tree where `git diff --quiet d4282e31 -- packages/test/src` exits 0 (also `packages/core/test` and `spec`: exit 0)
**Toolchain:** node v26.13.0, pnpm 11.20.0, `npx tsc -v` = `Version 7.0.2+effect-tsgo.0.67.4`
**Probe instrument:** `TS_API_PATH=$PWD/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript` (transitive copy, measuring instrument only; never added to a package.json)
**Method:** each gate run on its own from the worktree root in the order below, exit code taken from the command, wall time measured with `date +%s` around the command (whole seconds). `tsc -b` ran first because `test:bdd` and `package:smoke` read the built `lib/` (its 0 s is an up-to-date incremental build). Output of every gate saved outside the repo.

## Gate results

| Gate | Command | Exit | Summary line printed | Wall time |
|------|---------|------|----------------------|-----------|
| tsc -b | `npx tsc -b tsconfig.json` | 0 | (no output) | 0 s (incremental, up to date) |
| tests typecheck | `npx tsc -p tsconfig.test.json` | 0 | 0 `error TS`; 2 pre-existing `warning TS377149` in `features/step-definitions/TestingHarnessSteps.ts` (lines 851, 853) | 4 s |
| circular | `pnpm circular` | 0 | `$ node scripts/circular.mjs` (no findings) | 3 s |
| error tags | `pnpm check:error-tags` | 0 | `error-tags: 163 internal and 137 wire error tags, none shared` | 1 s |
| transactions | `pnpm check:transactions` | 0 | `check-transactions: no bare sql.withTransaction in packages/*/src` | 0 s (<1 s) |
| contract tests | `pnpm check:contract-tests` | 0 | `contract-tests: all 21 plugin classes run the contract suite; @awthaq/test stays dev-only` | 1 s |
| lint | `pnpm lint` | 0 | oxlint: warnings only (87 under untracked `.claude/`, 7 in `features/step-definitions/RequestContextSteps.ts`), no errors | 1 s |
| format | `pnpm format:check` | 0 | `All matched files use the correct format. ... on 1205 files` | 0 s (<1 s) |
| readmes | `pnpm check:readmes` | 0 | `readme-status: every package README matches its package's shipped state` | 1 s |
| workspace | `pnpm workspace:check` | 0 | `sync-workspace: 29 packages and 3 examples match every roster` | 0 s (<1 s) |
| bdd | `pnpm test:bdd` | 0 | Test Files 39 passed (39); Tests 1576 passed, 44 skipped (1620) | 9 s |
| unit | `pnpm test` | 0 | Test Files 410 passed, 4 skipped (414); Tests 6490 passed, 1 expected fail, 15 skipped (6506) | 54 s |
| coverage | `pnpm coverage` | 0 | Statements 91.65, Branches 85.08, Functions 86.91, Lines 92.17 (floors 89 / 83 / 84 / 90); same 410 / 4 skipped files, 6490 / 1 expected fail / 15 skipped tests | 88 s |
| spec | `pnpm spec:verify:strict` | 0 | `PASS: 32   FAIL: 0   SKIP: 0 (strict: skips count as failures)` | 61 s |
| knip | `pnpm knip` | **1 (pre-existing)** | `Unused files (39)` (all under untracked `.claude/`), `Unlisted dependencies (3)` | 107 s |
| package smoke | `pnpm package:smoke` | 0 | `package:smoke: PASS <pkg>` for each of the 30 packages (30 PASS, 0 other) | 62 s |

`TestAuth.ts` coverage row at capture: 83.94 statements, 77.96 branches, 86.39 functions, 84.8 lines (informational; the global floors above are the gate).

Not run locally: `Migration.postgres.test.ts` and any other Postgres-gated test (`AWTHAQ_POSTGRES_URL` unset; they are skipped inside the counts above).

## Phase-specific pins

| Pin | Command | Exit | Summary line printed | Wall time |
|-----|---------|------|----------------------|-----------|
| `test` project | `npx vitest run --project test` | 0 | Test Files 33 passed (33); Tests 627 passed, 1 expected fail (628) | 7 s |
| census pair | `npx vitest run --project core packages/core/test/SignInSeams.test.ts packages/core/test/RequestContextSeams.test.ts` | 0 | Test Files 2 passed (2); Tests 17 passed (17) | 0 s (<1 s) |
| Schema.lock (13 files) | `npx vitest run Schema.lock.test` | 0 | Test Files 13 passed (13); Tests 13 passed (13) | 6 s |
| plugin Contract suites (16 files) | `npx vitest run test/Contract.test.ts` | 0 | Test Files 16 passed (16); Tests 1597 passed (1597) | 8 s |

## knip (raw)

Full `pnpm knip` output (trailing whitespace trimmed), exit code 1:

```text
$ knip
Unused files (39)
.claude/gsd-core/bin/check-latest-version.cjs
.claude/gsd-core/bin/ensure-runtime-build.cjs
.claude/gsd-core/bin/gsd-tools.cjs
.claude/gsd-core/bin/verify-reapply-patches.cjs
.claude/hooks/gsd-agent-isolation-guard.js
.claude/hooks/gsd-check-update-worker.js
.claude/hooks/gsd-check-update.js
.claude/hooks/gsd-config-reload.js
.claude/hooks/gsd-context-monitor.js
.claude/hooks/gsd-cursor-post-tool.js
.claude/hooks/gsd-cursor-pre-tool.js
.claude/hooks/gsd-cursor-session-start.js
.claude/hooks/gsd-cursor-stop.js
.claude/hooks/gsd-cursor-subagent-start.js
.claude/hooks/gsd-cursor-subagent-stop.js
.claude/hooks/gsd-ensure-canonical-path.js
.claude/hooks/gsd-path-export.js
.claude/hooks/gsd-prompt-guard.js
.claude/hooks/gsd-read-guard.js
.claude/hooks/gsd-read-injection-scanner.js
.claude/hooks/gsd-secret-read-guard.js
.claude/hooks/gsd-statusline.js
.claude/hooks/gsd-update-banner.js
.claude/hooks/gsd-windsurf-pre-command.js
.claude/hooks/gsd-windsurf-pre-write.js
.claude/hooks/gsd-workflow-guard.js
.claude/hooks/gsd-worktree-path-guard.js
.claude/hooks/gsd-write-guard.js
.claude/hooks/managed-hooks-registry.cjs
.claude/scripts/changeset/cli.cjs
.claude/scripts/changeset/github-release-notes.cjs
.claude/scripts/changeset/lint.cjs
.claude/scripts/changeset/new.cjs
.claude/scripts/changeset/parse.cjs
.claude/scripts/changeset/render.cjs
.claude/scripts/changeset/serialize.cjs
.claude/scripts/fix-slash-commands.cjs
.claude/scripts/gen-capability-registry.cjs
.claude/scripts/gen-loop-host-contract.cjs
Unlisted dependencies (3)
@awthaq/core      packages/sql/test/fixtures/readme-quickstart.ts:2:10
@awthaq/password  packages/sql/test/fixtures/readme-quickstart.ts:11:10
@awthaq/server    packages/sql/test/fixtures/readme-quickstart.ts:12:10
[ELIFECYCLE] Command failed with exit code 1.
```

Filtered form, `pnpm knip 2>&1 | grep -v '^\.claude/' | grep -v '^\.reports/'`:

```text
$ knip
Unused files (39)
Unlisted dependencies (3)
@awthaq/core      packages/sql/test/fixtures/readme-quickstart.ts:2:10
@awthaq/password  packages/sql/test/fixtures/readme-quickstart.ts:11:10
@awthaq/server    packages/sql/test/fixtures/readme-quickstart.ts:12:10
[ELIFECYCLE] Command failed with exit code 1.
```

No unused exports, no unused dependencies, nothing under `packages/` other than the three unlisted-dependency rows. (Identical to the Phase 1 baseline.)

## Working tree at capture

`git status --short` (verbatim, taken after the gates; `02-SURFACE-BEFORE.txt` is the Step A output, written before the gates):

```text
?? .claude/.gsd-profile
?? .claude/agents/
?? .claude/commands/
?? .claude/gsd-core/
?? .claude/gsd-file-manifest.json
?? .claude/gsd-install-state.json
?? .claude/hooks/
?? .claude/scripts/
?? .planning/phases/02-split-testauth/02-SURFACE-BEFORE.txt
?? .planning/state.json
```

`git diff --stat knip.json` (verbatim):

```text
(empty: knip.json is unmodified at capture)
```

Recorded as found; nothing was reverted or edited.

## Surface snapshot

The probe is a one-off script kept in a temporary directory outside the repo and never committed (a committed `.cjs` would be a new knip "Unused files" row). It runs against the TypeScript 5.9.3 compiler API from the pnpm store because the repo's `typescript` 7.0.2 (tsgo) exposes none.

Command (from the worktree root):

```text
TS_API_PATH="$PWD/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript" node <tmpdir>/surface-probe.cjs packages/test/src/TestAuth.ts > .planning/phases/02-split-testauth/02-SURFACE-BEFORE.txt
```

Probe source (verbatim):

```js
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
  if (target.flags & ts.SymbolFlags.Value) lines.push(`value: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(target, sf), undefined, F)}`);
  if (target.flags & ts.SymbolFlags.Type) {
    const t = checker.getDeclaredTypeOfSymbol(target);
    const tps = (t.aliasTypeArguments ?? t.typeParameters ?? []).map((p) => checker.typeToString(p)).join(", ");
    lines.push(`type<${tps}>: ${checker.typeToString(t, undefined, F | ts.TypeFormatFlags.InTypeAlias)}`);
    if (target.flags & ts.SymbolFlags.Interface) {
      for (const p of checker.getPropertiesOfType(t).sort((a, b) => a.name.localeCompare(b.name))) {
        const opt = p.flags & ts.SymbolFlags.Optional ? "?" : "";
        const decl = p.valueDeclaration ?? p.declarations?.[0];
        const ro = decl && ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Readonly ? "readonly " : "";
        lines.push(`  ${ro}${p.name}${opt}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(p, sf), undefined, F)}`);
      }
    }
  }
}
process.stdout.write(lines.join("\n") + "\n");
```

Counts of `02-SURFACE-BEFORE.txt`: 176 lines; 47 headings (`^## `); 23 ending `[value]`; 24 ending `[type]`; 0 `[value+type]`; 0 occurrences of `import(` (every module resolved).

Determinism: the probe was run twice on the same tree; `diff` of the two outputs is empty.

The 23 value names (sorted by code unit, `LC_ALL=C sort`): TestCsrfConfig buildContext csrfSetCookie csrfToken encryption httpClient layer lazyApp listen memoryFoundation migratedSchema openApps recordModes runPluginContractTests runSealedColumnTests runTenantIsolationTests serve sessionSetCookie signInAs throwingFramework withApp withRequest withoutRequest

The 24 type names (sorted by code unit): AgentOptions App AppNeeds CommonOptions ContractTestOptions FoundationServices KeyedProbe LazyApp ListeningApp MemoryMode MethodClass Probe RecordsOption RequestInit RetentionRegistryService SealedColumnConfig ServeOptions SignInOptions SignedInAgent SignedInSession SqlMode TableCase TenantIsolationConfig TestFramework

## Known intermittent

`packages/passkey/test/Contract.test.ts > runPluginContractTests > RecordsContract: passkey > ... ChallengeStore (memory) > consume [atomic]: false for any other value, a tampered one included` failed 1 of 4 runs at `d4282e31` during planning (cause not investigated, outside this phase's allowlist). It did not occur in the capture run above (`test/Contract.test.ts`, `pnpm test`, `pnpm coverage` all green first time). Rule: if a command's only failure is this case, re-run that command once and record both runs; any other failure is a real regression.

## Phase-close comparison rule

Every gate exits as it did here: all gates 0 except `pnpm knip`, which exits 1 for the pre-existing reasons above.

Test, file and coverage counts may only grow; coverage stays at or above the floors 89 / 83 / 84 / 90; `pnpm spec:verify:strict` stays `PASS 32 / FAIL 0`. The `test` project grows by exactly one file (`TestAuthSurface.test.ts`) and its cases.

knip's filtered output keeps only the banner, the headings, the three `readme-quickstart.ts` rows and the ELIFECYCLE line, with no row under `packages/test/src/internal`; `git diff --stat knip.json` stays empty.

The AFTER probe, run with the same source and `TS_API_PATH` against the post-split `packages/test/src/TestAuth.ts`, must diff empty against `02-SURFACE-BEFORE.txt`. A diff is reported, never resolved by editing the BEFORE file.

Phase allowlist, measured from `d4282e31`: `packages/test/**`, `packages/core/test/SignInSeams.test.ts`, `packages/core/test/RequestContextSeams.test.ts`, `spec/**`, `.planning/**`. No `.cjs`/`.mjs` file is added by the phase.
