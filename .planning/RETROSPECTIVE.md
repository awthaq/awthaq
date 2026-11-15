# Retrospective

## Milestone: v1.0 Architecture Deepening, batch 3

**Shipped:** 2026-11-15
**Phases:** 7 | **Plans:** 52

### What Was Built

Eight deepening candidates from the architecture review: one CLI views module and `ConfigList` removal; `TestAuth` split behind an identical facade; one keyset page module; one connection-lifecycle service for SAML and OIDC; one `CoreTables` catalogue; two record-store helpers (`StoreFailure.labelled`, `Keyset.chronological`) chosen by a per-helper go/no-go spike; a small World event-capture scaffold; and `Credentials.ts` split into `internal/` modules behind a 30-name facade.

### What Worked

- Pinning the old behaviour first (golden cursor bytes, surface snapshots, order pins, byte pins) and keeping those oracles unedited through every adoption.
- A mechanical go/no-go rule fixed before measuring (Phase 6) kept three helpers out rather than padding the milestone.
- Each phase's review, security, validation and verifier passes caught real defects (a red `tsc -b` after a review fix, an overstated reason in a table, a stale oracle claim).

### What Was Inefficient

- Roadmap premises were partly wrong twice (Phase 5's lists, Phase 7's "shared tail"); research found it each time, but the requirement wording needed rewording afterwards.
- The throwaway Postgres container leaks one schema per test layer, so full runs needed a fresh container and produced recurring 5 s timing intermittents.
- No git remote, so every Postgres result is a local run with CI confirmation open.

### Patterns Established

- Verbatim-move proofs (sorted line multiset plus probe diff) for pure file splits; facades of explicit named re-exports.
- Recorded mutation checks restored from byte copies for every new pin.
- Orchestrator-only requirement and phase bookkeeping; executors stage explicit paths.

### Key Lessons

- Measure the repeated code before promising a scaffold; deletion test first.
- A type-level pin must be checked by the project that actually compiles it, and Effect language-service diagnostics need their own suppression.
- Keep review fixes under the same gates as plans (the one regression this milestone came from a review fix).

### Cost Observations

- Model mix: planner on opus, everything else on sonnet.
- Notable: Postgres full-suite legs dominated wall time.

## Cross-Milestone Trends

| Milestone | Phases | Plans | Notes |
|-----------|--------|-------|-------|
| v1.0 | 7 | 52 | First GSD milestone in this repo |
