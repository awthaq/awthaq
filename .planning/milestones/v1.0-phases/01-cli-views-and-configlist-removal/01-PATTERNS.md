# Phase 1: CLI views and ConfigList removal - Pattern Map

**Mapped:** 2026-11-14
**Files analyzed:** 11 (CONTEXT.md absent; list taken from RESEARCH.md)
**Analogs found:** 10 / 11

All analog paths are git-tracked (checked with `git ls-files`). Base dir for `src/` and `test/`: `packages/cli/`.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `packages/cli/src/PluginViews.ts` (new) | utility (resolve + render) | transform / request-response | `packages/cli/src/Output.ts` `report` (80-85) plus `Plugin.ts` `show` (254-288) | role-match |
| `packages/cli/src/Output.ts` (modify `report`) | service | request-response | itself | exact |
| `packages/cli/src/Plugin.ts` (modify `show`) | command logic | request-response | itself | exact |
| `packages/cli/src/Cli.ts` (inline `config list`, drop import line 40) | route/command | request-response | itself (`configList`, ~152) | exact |
| `packages/cli/src/ConfigList.ts` (delete) and `src/index.ts:12` (drop export) | module | request-response | n/a | n/a |
| `packages/cli/src/Openapi.ts` (modify `emit`) | command logic | request-response | `Migration.status` (already uses `Output.report`, `Migration.ts:64`) | role-match |
| `packages/cli/test/PluginViews.test.ts` (new) | test | request-response | `packages/cli/test/Inspection.test.ts` | exact |
| `packages/cli/test/Doctor.test.ts` (edit lines 24, 237) | test | request-response | `packages/cli/test/support/RunCli.ts` `runCli` usage | role-match |
| `.changeset/<name>.md` (new) | config | n/a | `git show 1cef4beb:.changeset/cli-link-errors.md` (file since consumed by versioning) | exact |
| `spec/behaviors/26-cli.md` (lines 46, 70, 398, Revision 1.9 -> 1.10, Change History) | docs | n/a | its own Change History rows | exact |
| `.planning/phases/01-.../01-BASELINE.md` (new) | docs | n/a | none | no analog |

## Pattern Assignments

### `Output.ts` `report` (additive override)

**Current** (`Output.ts:80-85`, verbatim):
```typescript
export const report = <A>(value: A, render: (value: A) => ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const out = yield* Output;
    if (out.json) return yield* out.document(value);
    yield* Effect.forEach(render(value), out.line, { discard: true });
  });
```
**Target:** add third param `options?: { readonly json?: boolean }` and test `options?.json ?? out.json`. Do not touch `failure` / `failureDocument`. No return-type annotation, no `as`.

### `PluginViews.ts` (generic, imports only `Output.ts`, so there is no cycle with `Plugin.ts`)

**Analog dispatch to replace** (`Plugin.ts:254-288`; the same four-way branch repeats for hooks, rules and events):
```typescript
const out = yield* Output.Output;
if (options.hooks === true) {
  if (options.format === "json" || out.json) return yield* out.document(hooks(auth));
  return yield* Effect.forEach(renderHooks(hooks(auth)), out.line, { discard: true });
}
... // rules, events identical
const nodes = graph(auth);
if (options.format === "dot") {
  return yield* Effect.forEach(renderDot(nodes), out.line, { discard: true });
}
if (options.format === "json" || out.json) return yield* out.document(nodes);
if (options.graph) return yield* Effect.forEach(renderText(nodes), out.line, { discard: true });
yield* Effect.forEach(nodes, (node) => out.line(`${node.order}. ${nod...
```
**Resolver contract** (RESEARCH, verified by running every cell):
- dotCapable (graph/default only) and format is "dot": "dot". Dot beats `--json`.
- format is "json" or `out.json`: "json", one document even when both flags are set.
- Otherwise "text".

Dot and text both go through `Output.report(rows, renderer, { json: false })`. Json goes through `{ json: true }`. A view with no dot renderer treats "dot" as non-dot. Selector precedence stays hooks > rules > events > graph/default, and it stays in `Plugin.show`. Keep `Plugin.show` and `Plugin.Format` public.

### `Cli.ts` inline `config list`

**Current handler** (`Cli.ts:~152`):
```typescript
const configList = Command.make("list", {}, () =>
  withOutput(load.pipe(Effect.flatMap(ConfigList.show))),
).pipe(Command.withDescription("List every declared configuration input, ..."));
```
**Body to inline** (`ConfigList.ts:17-28`):
```typescript
export const renderText = (items: ReadonlyArray<EffectiveConfig.Item>) =>
  items.flatMap((item) => [
    `${item.owner}  ${item.key}  (${item.source})`,
    ...item.entries.map((entry) => `  ${entry.path} = ${entry.value}`),
  ]);
// show:
const context = yield* Doctor.configContext(config);
const items = EffectiveConfig.read(context, Doctor.descriptorsOf(config));
yield* Output.report(items, renderText);
```
Name the inlined renderer `renderConfigItems`, because `Doctor.ts` already exports `renderText`. Add the `EffectiveConfig` import from `@awthaq/core`. Remove `import * as ConfigList` (line 40). Keep the 3-line header comment's BEH-EA-229 citation by moving it to the new location.

### `Openapi.ts` `emit` (CLI-04)

**Current** (`Openapi.ts:33-36`):
```typescript
if (options.out === undefined) {
  const out = yield* Output.Output;
  return yield* out.line(text);
}
```
**Target:** `return yield* Output.report(spec, () => [text])`. Leave the `--out` file branch alone. `--json` bytes are identical (`stringify` is `JSON.stringify(v, null, 2)`). Pin first with a test: text stdout equals `--json` stdout. `Migration.apply`: leave it, and record the reason in the plan summary (text and document are emitted at different points).

### `test/PluginViews.test.ts` (copy `Inspection.test.ts`)

**Imports** (`Inspection.test.ts:6-14`):
```typescript
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Output from "../src/Output.ts";
import * as Plugin from "../src/Plugin.ts";
import { hookedApp } from "./support/HookedApp.ts";
import { passwordAndRoles } from "./support/TestApp.ts";
```
**Capture idiom** (`Inspection.test.ts:97-105`; use this form, because the matrix needs all three refs):
```typescript
const { captured, layer } = yield* Output.capture(false);
yield* Plugin.show(passwordAndRoles, { graph: true, format: "json" }).pipe(Effect.provide(layer));
const [doc] = yield* Ref.get(captured.documents);
assert.deepStrictEqual(doc, Plugin.graph(passwordAndRoles));
```
**Real-argv cells** use `runCli(args, configOf(app))` from `test/support/RunCli.ts` and `test/support/TestApp.ts`. It returns `{ code, stdout, stderr, exit }`.

Assert on every json cell:
- `documents.length === 1`.
- `stdout.length === 1`.
- `stdout[0] === JSON.stringify(rows, null, 2)`.
- `stderr` is empty.

Gaps the matrix must close (not pinned today): the default view in any mode, any `out.json === true` case on `Plugin.show`, dot on hooks/rules/events, dot plus `--json`, selector precedence, `--format json` plus `--json` giving one document. Commit it green before any `src/` change.

### `test/Doctor.test.ts` (lines 24, 237)

**Current** (`Doctor.test.ts:236-239`):
```typescript
const listed = yield* Output.capture(false);
yield* ConfigList.show(config).pipe(Effect.provide(listed.layer));
const text = (yield* Ref.get(listed.captured.stdout)).join("\n");
```
**Replace** (do not keep both) with `const r = yield* runCli(["config", "list"], config); const text = r.stdout.join("\n");`. Drop the `ConfigList` import at line 24. Keep the `assert.include` / `notInclude` canary assertions unchanged.

### Changeset

**Analog** (`1cef4beb:.changeset/cli-link-errors.md`):
```markdown
---
"@awthaq/cli": patch
---

<prose, with BEH ids>

Migration: <what a consumer or script must now do>
```
Use `"@awthaq/cli": minor`. The `Migration:` line is mandatory (`CONTRIBUTING.md:95-104`). `.changeset/` currently holds only `config.json` and `publish-all-packages.md`.

### Spec `26-cli.md`

Bump Revision 1.9 to 1.10 and add a Change History row together (drift check 14, `spec/scripts/check-drift.mjs:203-224`). Edit the `ConfigList.ts` citations at lines 46 and 398. Line 70 cites `Plugin.ts`; also name `PluginViews.ts` and `test/PluginViews.test.ts`. Drift checks do not scan this prose, so finish with `grep -rn ConfigList spec packages docs examples features --exclude-dir=node_modules --exclude-dir=lib` returning nothing.

## Shared Patterns

- **Output seam:** all stdout goes through `Output.report` or `Output.Output` (`line`, `document`). Failures stay on `Output.failure` (global `--json` only, BEH-EA-225). Do not edit `failure`.
- **Secrets:** `config list` must still print `<redacted>`. The canary test is `Doctor.test.ts:231-246`.
- **Conventions (IMPLEMENTING.md):** no `as` casts, no return-type annotations on new Effect consts, replace tests rather than layering them, run `npx oxfmt <new paths>`.
- **Gates:** `npx tsc -b tsconfig.json && npx tsc -p tsconfig.test.json`, `pnpm circular` (counts type-only imports), `pnpm knip` compared against `01-BASELINE.md`. Run `pnpm clean && pnpm build` before `pnpm package:smoke`, because `lib/` is stale.

## No Analog Found

| File | Reason |
|---|---|
| `01-BASELINE.md` | Planning artifact. Use the RESEARCH.md "Gate baseline" table, the raw `pnpm knip` output, and `git status --short` plus `git diff --stat knip.json` at capture time. |

## Metadata

**Analog search scope:** `packages/cli/src`, `packages/cli/test`, `.changeset`.
**Not found:** `01-CONTEXT.md` is absent from the phase directory, so locked decisions were taken from the "User Constraints" section of RESEARCH.md.
**Extraction date:** 2026-11-14
