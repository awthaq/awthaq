# Phase 2: Split TestAuth - Pattern Map

**Mapped:** 2026-11-14
**Files analyzed:** 14 (4 new modules, 1 new test, 2 modified src, 2 core census tests, 3 spec files, 2 snapshots)
**Analogs found:** 12 / 14 (snapshots have none; they are probe output)

All analog paths below were checked as tracked (`git ls-files packages/test/src/internal` lists them). RESEARCH.md holds the line-level section map of `TestAuth.ts`; this file only adds the copy-from excerpts.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `packages/test/src/internal/composition.ts` | utility (layer composition) | transform | `packages/test/src/internal/foundation.ts` | role-match |
| `packages/test/src/internal/session.ts` | utility (mint) | request-response | `packages/test/src/internal/foundation.ts` | role-match |
| `packages/test/src/internal/appHarness.ts` | service (lifecycle) | event-driven (scope acquire/release) | `packages/test/src/internal/foundation.ts` + moved code | role-match |
| `packages/test/src/internal/contractRunner.ts` | test runner | batch | `packages/test/src/internal/contract.ts`, `StoreContract.ts` | role-match |
| `packages/test/src/internal/foundation.ts` (modify) | utility | transform | itself (`FoundationRegistries` `@public`) | exact |
| `packages/test/src/TestAuth.ts` (modify) | facade | n/a | its own lines 1858-1869 | exact |
| `packages/test/test/TestAuthSurface.test.ts` | test | pin | `packages/test/test/TestAuthLazy.test.ts` (imports), `packages/admin/test/AdminTier.test.ts:55` (key pin) | role-match |
| `packages/core/test/SignInSeams.test.ts`, `RequestContextSeams.test.ts` | census test | edit 4 literals | self | exact |
| `spec/behaviors/25-testing-harness.md`, `spec/traceability.md`, `spec/invariants.md` | spec | doc | Phase 1 commit `ffe1e99f` (`spec/behaviors/26-cli.md` bump) | exact |
| `02-SURFACE-BEFORE.txt` / `AFTER.txt` | artifact | n/a | none (probe script in RESEARCH.md) | none |

## Shared Patterns

### File header
Source: `internal/foundation.ts:1-2`. One `//` line naming the package and the concern, no block banner.
```ts
// @awthaq/test — the memory foundation, shared by `TestAuth` and `RecordsContract` (plan 25) without
// either importing the other.
```
New modules: `// @awthaq/test — <concern>, behind the TestAuth facade (spec/behaviors/25-testing-harness.md, BEH-EA-xxx).` Never mention or import `TestAuth.ts` in code (cycle).

### Imports style (copy from `foundation.ts:4-16` and `TestAuth.ts:64-130`)
- Order used by the existing file: `@awthaq/*` workspace packages (named imports, inline `type` for type-only), then `@effect/*`/`node:` modules, then `effect/<Module>` deep imports (`import * as Layer from "effect/Layer"`, never the barrel), then relative sibling files.
- Siblings of `src/` are reached from `internal/` as `../TestSql.ts`, `../TestEncryption.ts`; always the `.ts` extension.
- Type-only: `import type * as Duration from "effect/Duration"`; `type DataExport` inline; `export type { X } from`.
- Use the per-module import table in RESEARCH.md ("Imports needed per module"); `noUnusedLocals` makes `npx tsc -b tsconfig.json` the check.
```ts
import { AuditChain, AuditLog, AuthEvents, type DataExport, type Erasure, Hooks, Persistence, type Retention } from "@awthaq/core";
import type { Encryption } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";
import * as TestEncryption from "../TestEncryption.ts";
```
Internal-to-internal: `import { withRequest, signInAs } from "./session.ts";` (harness), `import { makeLayer, recordModes } from "./composition.ts"; import { memoryFoundation } from "./foundation.ts";` (runner).

### `@public` JSDoc for names kept only for declaration emit (`foundation.ts:19-24`)
```ts
/**
 * Named so the foundation's inferred type can be emitted (declaration emit needs the namespaces in scope).
 * @public
 */
export type FoundationRegistries = ...
```
Use for `RetentionRegistryService` / `FoundationServices` moved into `foundation.ts` (no consumer uses them by name; knip would flag them otherwise, though facade re-exports also count as use).

### Facade re-export form (`TestAuth.ts:158-160`, `1858-1869`)
Named only, never `export *`; types via `export type { }`; one `from` per module.
```ts
export { memoryFoundation } from "./internal/foundation.ts";
export { runSealedColumnTests } from "./SealedConformance.ts";
export type { SealedColumnConfig } from "./SealedConformance.ts";
export type {
  KeyedProbe,
  MethodClass,
  Probe,
  TableCase,
  TenantIsolationConfig,
} from "./TenantConformance.ts";
```
Keep the existing trailing sibling block (lines 1858-1869) and `export type { TestFramework } from "./TestFramework.ts";` unchanged. The full 47-name export list per module is in RESEARCH.md "Facade export list"; keep the header comment (lines 1-63; spec cites it), reword line 6's "wired in below" to name `internal/composition.ts`. Do not export `makeLayer`: it is exported from `composition.ts` for the runner only.

### Move discipline
Verbatim moves, no retyping (repo rule: no `as` assertions in `packages/*/src`, no return-type annotations on Effect/Layer consts). `layer`'s two overloads plus implementation move with `testPorts`, `TestProvided`, `Guarded`, `GuardIn`, `Provided`, `Requires`, `makeLayer` (TS2883 avoidance). `openAppCount` (4 occurrences: decl, `openApps`, `++` in `make`, `--` in release) stays in `appHarness.ts` only.

## Pattern Assignments

### `internal/session.ts`, `composition.ts`, `appHarness.ts`, `contractRunner.ts`
Analog for structure: `internal/foundation.ts` (header, deep `effect/*` imports, `../` sibling imports, exported named consts with doc comments). Content comes from moving the `TestAuth.ts` line ranges in RESEARCH.md "Section map". Dependency DAG: `appHarness -> session`; `contractRunner -> composition, foundation`; no one imports `../TestAuth.ts`.

### `packages/test/test/TestAuthSurface.test.ts`
Imports style from `test/TestAuthLazy.test.ts:1-8`; key-pin idiom from `packages/admin/test/AdminTier.test.ts:55`.
```ts
// Pins the runtime value surface of TestAuth (plan 25 facade split): a leaked internal helper or dropped value fails here.
import { assert, it } from "@effect/vitest";
import * as TestAuth from "../src/TestAuth.ts";

it("the TestAuth value surface is exactly these names", () => {
  assert.deepStrictEqual(Object.keys(TestAuth).sort(), [/* 23 names, sorted, from the Wave 0 run */]);
});
```
The array must be generated from `Object.keys` at Wave 0 (note `sort()` is code-unit order, so uppercase `TestCsrfConfig` sorts before lowercase names; do not hand-sort). Green before any `src` change.

### `packages/core/test/SignInSeams.test.ts` (lines 81, 138) and `RequestContextSeams.test.ts` (lines 99, 178)
Edit only the `file:` literal in each entry, same commit as the extraction:
```ts
{ file: "test/src/TestAuth.ts", count: 1, why: "signInAs mints a session ..." }   // before (line 81, 138)
{ file: "test/src/internal/session.ts", count: 1, why: "..." }                    // after
```
Targets: line 81 and 138 -> `test/src/internal/session.ts`; line 99 (`ClientAddress.ClientAddress`, count 2) -> `test/src/internal/composition.ts`; line 178 (`AuthRequestContext.noRequest`) -> `test/src/internal/session.ts`. Do not touch `count` or `why`. Run `npx vitest run --project core packages/core/test/SignInSeams.test.ts packages/core/test/RequestContextSeams.test.ts` after each extraction.

### Spec files
Analog: Phase 1 commit `ffe1e99f` (`26-cli.md` Revision 1.9 -> 1.10). Per file: bump the `> | Revision |` cell, the Effective Date, and append ` <br> N.N (2026-11-14): ...` at the END of the Change History cell (lines are `> `-prefixed). Targets: 25-testing-harness.md 1.15 -> 1.16 (lines 313 composition.ts, 336/356/372 appHarness.ts); traceability.md 1.89 -> 1.90 (lines 51, 336-338); invariants.md 1.9 -> 1.10 (line 189 -> contractRunner.ts). Check 10 only validates backticked `packages/...` paths, so verify `@awthaq/test/src/...` paths with `test -f`.

## No Analog Found

| File | Reason |
|---|---|
| `TestAuth.ts` as pure facade | No existing top-level file is facade-only; use its own lines 158-160 and 1858-1869 as the style |
| `02-SURFACE-*.txt` | Generated by the RESEARCH.md probe (TS 5.9.3 from the pnpm store); never commit the script (knip) |

## Metadata

**Analog search scope:** `packages/test/src`, `packages/test/test`, `packages/{admin,core}/test`
**Files read:** CONTEXT.md, RESEARCH.md, `internal/foundation.ts` head, `TestAuth.ts` imports and tail, `TestAuthLazy.test.ts` head, `SignInSeams.test.ts` excerpt
**Extraction date:** 2026-11-14
