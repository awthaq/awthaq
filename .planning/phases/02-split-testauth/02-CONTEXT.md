# Phase 2: Split TestAuth - Context

**Gathered:** 2026-11-14
**Status:** Ready for planning

<domain>
## Phase Boundary

`packages/test/src/TestAuth.ts` (1869 lines) becomes a thin facade over concern-scoped modules under `packages/test/src/internal/`: composition, session/CSRF minting, app harness and contract runner. The exported `TestAuth.*` name set is identical before and after, no consumer outside `packages/test` is edited, `buildContext` stays exported, `migratedSchema` still calls `TestSql.schemaOf`, the open-app counter stays beside `serve`/`openApps`, `LeakGuard` accounting is unchanged, and the spec and traceability cite the new implementation locations (keeping the cited test file names).

Requirements: TEST-01, TEST-02, TEST-03, TEST-04. File-disjoint from Phase 1.

</domain>

<decisions>
## Implementation Decisions

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

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/test/src/internal/foundation.ts` (63 lines, `memoryFoundation`) and `internal/contract.ts` (84 lines) are already re-exported from `TestAuth.ts`.
- `packages/test/src/internal/storeContract/` holds the record-store contract suites (about 2.8k lines): the existing example of a concern split with its own tests.
- Sibling files `SealedConformance.ts`, `TenantConformance.ts`, `RecordsContract.ts`, `TestSql.ts`, `TestEncryption.ts`, `TestFramework.ts` are already extracted and re-exported from the facade (bottom of `TestAuth.ts`, around lines 1860-1869).

### Established Patterns
- Facade re-export style: `export { x } from "./internal/foundation.ts"` and `export type { ... } from "./X.ts"`.
- `TestAuth.ts` mixes, in one file: composition (`layer` overloads, `CommonOptions`, `SqlMode`/`MemoryMode`, around lines 150-430), session/CSRF minting (`SignedInSession`, `sessionSetCookie`, `signInAs`, `csrfToken`, `csrfSetCookie`, around 430-540), the app harness (`App`, `ServeOptions`, `serve`, `listen`, `withApp`, `lazyApp`, `openAppCount`/`openApps`, around 540-935), and the contract runner (`ContractTestOptions`, `migratedSchema`, `runPluginContractTests`, around 996-1860).

### Integration Points
- `packages/test/src/index.ts` re-exports `TestAuth`; consumers across the monorepo import `TestAuth.*` through `@awthaq/test`.
- `spec/behaviors/25-testing-harness.md` and `spec/traceability.md` cite `packages/test/src/TestAuth.ts` as the implementation location.
- `LeakGuard` accounting and the `Schema.lock.test.ts` files (12) depend on `openApps`/`openClients`.

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches. The user's standing instruction for this milestone: the cleanest solution, not the simplest; complexity is accepted.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. (Phase 7's test-host composer for the BDD Worlds is separate and lives in `features/step-definitions/shared`.)

</deferred>
