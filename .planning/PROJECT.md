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
| Run executors sequentially in the milestone worktree (`workflow.use_worktrees=false`) | The worktree is the only checkout with `node_modules` and a built `lib/`; per-plan sub-worktrees would need a fresh install and merge-back | ✓ Phase 1 |
| Pin output before moving it: baseline and test matrix commit green before any `src` change | A behaviour-preserving refactor needs an oracle that predates it | ✓ Phase 1 |
| `config list` inlined into `Cli.ts`, `ConfigList` removed from the `@awthaq/cli` export (minor changeset with `Migration:` line) | A single-use module behind a public export was a pass-through; the ECS-005 canary guards redaction | ✓ Phase 1 |
| `Output.report` takes an optional `{ json }` override; plugin views resolve `--format`/`--json` once in `PluginViews.ts` | Dot beats `--json` on graph/default only; the override keeps that precedence exact | ✓ Phase 1 |
| `Migration.apply` result and `openapi` stdout go through `Output.report`; the apply status preview stays hand-guarded | The preview prints before the drift and pending checks, while `report` couples text and document at one point | ✓ Phase 1 |
| `TestAuth.ts` is a named-re-export facade over `internal/{composition,session,appHarness,contractRunner}.ts`; the export surface is pinned by `TestAuthSurface.test.ts` | The surface diff and a permanent runtime-key pin make the split provably non-breaking; `internal/` modules never import the facade (`pnpm circular` counts type-only imports) | ✓ Phase 2 |
| The two core census tests keep scanning source text; only their four `file:` literals changed | They import nothing from `TestAuth`, so they are not consumers; ROADMAP criterion 1 was reworded to say so | ✓ Phase 2 |
| One `Keyset` module in `@awthaq/ports` (`paginate`, `window`, clamp 1..200 default 50) and a `KeysetSql` builder in `@awthaq/sql`; adapters supply only `fetch`, so `+1` is applied once by construction | Three listings had three page contracts and five `limit + 1` sites; the declared order now derives the memory comparator, the SQL seek and the ORDER BY | ✓ Phase 3 |
| Cursor wire bytes unchanged; `UserStore` page field `next` renamed `nextCursor` (one `Migration:` changeset) | The wire is the public contract and is pinned by a golden test; the port-field rename is the one intended breaking change, pre-1.0 | ✓ Phase 3 |
| Mixed-case ids are asserted for self-consistency, canonical uuidV7 ids for exact code-unit order; no `COLLATE "C"` | Verified on Debian `postgres:16` (`en_US.utf8`), the image CI uses; local `test:pg` uses alpine and hides drift | ✓ Phase 3 |
| One exposed `OrganizationConnectionLifecycle` service in `organization` owns claim-then-write, release and the suspended-organization gate for SAML and OIDC, parameterized by a protocol descriptor (`{ protocol, refuse, taken, isGone }` plus caller `prepare`/`write`); events stay with the callers | Two protocols had drifted copies of the claim sequence and different gates; the module keeps `organization` free of SAML types and makes the policy (`findActive` on create, update and refresh, none on remove) one decision | ✓ Phase 4 |
| `DomainClaims` serialises per organization with an advisory lock (`organization_domain_claim:org:<id>`), claims first, owner rows inserted sorted and read in input order; the OIDC secret is sealed before the lock | A reproduced Postgres update-vs-remove deadlock and an opposite-order two-organization deadlock; no external IO may run under the lock | ✓ Phase 4 |
| `DomainClaims` leaves the organization root export (stays on `@awthaq/organization/records`); SCIM is untouched and its `createConnection` orphan is recorded as F-04-01 | The claim table is a records boundary, not a plugin surface; SCIM has no domains or update | ✓ Phase 4 |
| One `CoreTables` catalogue in `@awthaq/sql` (name, owner, tenancy `partitioned|directory|none`, `replicated`, sealed view over `CoreSealedColumns`, optional reason; no column types or DDL) is the single list; `TenantScope` lists, `Auth.ts` Derived-parent check (stamped view), `LaggingReplica.coreTables` and the BDD stamped-table assertion project from it; `auth_relay_cursor` and `rate_limit_buckets` are classified `none`, not replicated, with reasons | Two real hand copies and two unclassified core tables remained, so the roadmap's minimal-fix branch did not apply; a drift guard (SQLite and Postgres) fails when a core migration creates an unclassified table, and the sealed AADs are pinned by inline literals | ✓ Phase 5 |

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
*Last updated: 2026-11-14 after Phase 5*
