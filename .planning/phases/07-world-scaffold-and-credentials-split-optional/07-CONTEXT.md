# Phase 7: World scaffold and Credentials split - Context

**Gathered:** 2026-11-15 (autonomous; no discuss questions: roadmap research was "skip" and every grey area is locked by REQUIREMENTS.md and the user's standing rule: cleanest end state, complexity accepted)
**Status:** Ready for planning
**Requirements:** WORLD-01, WORLD-02, CRED-01

## Boundary

Two independent candidates, both file-disjoint:

1. **C3, World scaffold** (`features/step-definitions/` only). Classify every World as `scaffolded` or `exempt`; add a scaffold in `features/step-definitions/shared/` that wraps `TestAuth.layer` and supplies the shared host tail (`lazyApp`, `TestClock`, capture layers) to the Worlds that repeat it.
2. **C8, Credentials split** (`packages/server/src/Credentials.ts`, 678 lines). Pure file split under `packages/server/src/internal/`; every `Credentials.*` name stays on the public namespace (export-name diff empty); ADR-EA-042 untouched.

## Locked decisions

- **D-01 (scaffold home):** the scaffold lives in `features/step-definitions/shared/` only. No change to `packages/test` (`TestAuth` itself stays as Phase 2 left it) and no second host composer anywhere.
- **D-02 (exempt Worlds):** the five hand-wired exempt Worlds are not migrated and not edited (ROADMAP criterion 2). The classification table names them and states why each is exempt. The table is a committed artifact (`07-WORLD-TABLE.md`) and, if cheap and non-brittle, pinned by a test that fails when a new World is added without a classification.
- **D-03 (gates kept):** `LeakGuard` accounting is unchanged; omitting a plugin from a scaffolded World is still a compile error (the existing compile-time gate files keep passing; a type-level pin proves the scaffold does not widen the plugin requirement).
- **D-04 (behaviour):** `pnpm test:bdd` keeps the same scenario count and results (baseline: 1580 passed / 44 skipped, 39 files, from Phase 6 close). Scaffolding must be behaviour-preserving: same layer order, same clock, same capture semantics.
- **D-05 (deletion test):** a World is `scaffolded` only if the scaffold removes real repeated tail code from it (deletion test: the repeated lines vanish, not move). A World that repeats only part of the tail, or varies the tail in a way the scaffold would need an option for, is `exempt` unless the option is a single honest parameter. Cleanest end state over maximal adoption; if fewer than about 4 Worlds truly repeat the tail, the honest outcome is a smaller scaffold plus a table, and that is recorded, not padded.
- **D-06 (Credentials split):** split by concern into `packages/server/src/internal/*.ts`; `Credentials.ts` stays as the public module re-exposing the same namespace members. The export-name diff (before/after, including types) must be empty, `.d.ts` shape of the public namespace unchanged, and `api-key`, `jwt`, `qadi`, `web` and `test` compile without edits. No behaviour change, no renames, no new exports. `madge`/`pnpm circular` (type-only cycles count) must stay clean; knip must not gain rows.
- **D-07 (ADR-EA-042):** untouched. If the split seems to need an ADR edit, stop and record why rather than editing.
- **D-08 (gates):** same gate set and comparison rule as Phase 6 (`06-BASELINE.md` shape): tsc -b, circular, error-tags, transactions, contract-tests, lint, format, readmes, workspace, spec:verify:strict, knip filtered, unit and bdd on SQLite and Postgres (container `awthaq-p3-pg`, recreate first, explicit `AWTHAQ_POSTGRES_URL`). Spec/changeset rows only if a package-visible or spec-visible change exists; a changeset is needed only if `@awthaq/server` output changes (a pure internal split should not: record the decision).

## Deferred / out of scope

- Migrating the exempt Worlds, or building a general World factory.
- Any `TestAuth` redesign (Phase 2 is closed).
- Splitting other large modules.

## Open for the researcher/planner (facts to establish, not decisions)

- The full World inventory (`features/step-definitions/*World.ts` and any inline World) with, per World, which of `lazyApp`, `TestClock`, capture layers it repeats and how it composes `TestAuth.layer`.
- Which five Worlds are the hand-wired exempt set (ROADMAP/ADR/Phase 2 artifacts name them) and why.
- `Credentials.ts` internal structure: natural seams, internal vs public members, who imports what, how the namespace is exported (`export * as`, object literal, namespace), and what ADR-EA-042 pins.
