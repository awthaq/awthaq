# awthaq

## What This Is

awthaq is a TypeScript authentication runtime built natively on Effect v4: every capability is a service, every contribution is a `Layer`, and plugins compose through the type checker. It is implemented, pre-1.0 and unpublished (see `spec/overview.md`). It serves applications that need sessions, credentials, organizations and federation, with authorization delegated to qadi.

## Core Value

Composition is checked by the compiler: a missing plugin, port or duplicate slot is a compile error, not a runtime surprise.

## Requirements

### Validated

- ✓ Plugin architecture, ports, core modules, SQL adapters, 20+ plugin packages and the CLI are implemented with passing suites (`spec/overview.md`, status banner)
- ✓ Architecture deepening plans 01-30 (batches 1-2, see `.planning/README.md`)

### Active

- [ ] Resolve the eight deepening candidates from the 2026-11-14 architecture review (see Current Milestone)

### Out of Scope

- New end-user features: this milestone only deepens existing modules
- Publishing to npm: the project stays unpublished

## Context

- Brownfield monorepo, `packages/*` plus `features/` (BDD) and `spec/` (ADR-EA-NNN, BEH-EA-NNN, traceability).
- `.planning/NN-name/PLAN.md` holds the earlier numbered deepening plans (01-30); `.planning/IMPLEMENTING.md` is their agent process. GSD artifacts now sit beside them.
- Decisions live in `spec/decisions/`; the domain glossary is `spec/overview.md`. Architecture vocabulary: module, interface, implementation, depth, seam, adapter, leverage, locality.
- The architecture review report is `/private/tmp/claude-502/-Users-mohammadalmechkor-Projects-Perso-awthaq/77238ac1-76b0-4bb3-a3a7-ec012e7983a4/scratchpad/architecture-review-20261114.html` (counts are unverified grep counts).

## Constraints

- **Quality bar**: the cleanest solution, not the simplest; complexity is accepted (user instruction, 2026-11-14)
- **ADRs**: do not silently contradict an ADR; surface and revise explicitly (ADR-EA-041, 042, 044, 054 are adjacent)
- **Verification**: each change passes `pnpm test`, `pnpm test:bdd`, `pnpm circular`, `pnpm spec:verify:strict`, and `pnpm test:pg` when a SQL adapter changes
- **Git**: never stage `.reports/`, `.claude/` or `.scratch/`

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Bootstrap GSD beside the existing numbered plans | User chose this on 2026-11-14 over continuing the plan-NN format | — Pending |
| Scope all 8 review candidates | User: "resolve all the Arch issues" | — Pending |

## Current Milestone: v1.0 Architecture Deepening, batch 3

**Goal:** Resolve all eight deepening candidates from the 2026-11-14 architecture review, choosing the cleanest end state.

**Target features:**
- Keyset-page module (admin, organization, ports, sql)
- Connection-lifecycle module (SAML, organization, SCIM)
- Test-host composer for the BDD Worlds
- Split `TestAuth.ts` by concern
- CLI plugin views behind `Output.report`, deleting `ConfigList`
- Single table catalogue (core/sql/cli)
- Shared record-store scaffolding (16 `*Records.ts` files)
- Fold the credential registry into `server/Credentials.ts`

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-11-14 after milestone v1.0 start*
