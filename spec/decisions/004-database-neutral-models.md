# ADR-EA-004: Database-Neutral Models

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-004 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Accepted — design; implementation deferred |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |

---

## Context

awthaq's persistence stratum (PRD §12) must support multiple SQL dialects (PostgreSQL, SQLite, MySQL are the named v1 targets per `research/10-schema-migrations.md` Q74) without plugin authors hand-writing dialect-specific DDL, and it must let plugins declare tables and migrations that compose safely — a plugin's `password_account` table must never collide with another plugin's tables, and a plugin extending a core table (`user`) must do so through a reviewed, declared mechanism rather than an ad hoc `ALTER TABLE` (research/10-schema-migrations.md Q78). An earlier design iteration answered this with a home-grown **schema intermediate representation (IR)** — a closed, JSON-serializable `ColumnType` union with per-dialect rendering (Q77) — plus a **diff planner**: a deterministic planner that would walk the aggregated IR in plugin-topological order, maintain a checksum ledger, detect drift, and gate destructive operations behind dry-run and explicit confirmation (`research/10-schema-migrations.md` Q75, Q76).

That IR-and-diff-planner design was necessary because `@effect/sql`'s stock `Migrator` was found to be "single-transaction, ids-only, no checksums, no dry-run, no drift detection" (`research/10-schema-migrations.md` TL;DR) — adequate as a simple runtime "apply" step, but not sufficient as the migration *engine* the project needs, and no `Model` abstraction existed yet to describe entities once and derive both validation schemas and repository operations from that one description. Once Effect v4's `Model.Class` and `SqlModel` repositories existed (ADR-EA-007), the core of what the schema IR was for — one entity description that yields both a validated domain schema and dialect-appropriate persistence operations — became a built-in Effect capability rather than bespoke infrastructure awthaq had to build and maintain. The diff-planner half of the old design (drift detection, checksum ledgers, destructive-change guardrails) remains valuable, but nothing about it needs to run inside the v1 runtime: it is squarely a **CLI-time** concern (schema generation, migration authoring, review), not something `Auth.make`'s Layer needs to carry at boot.

## Decision

Persistence is expressed with v4's `Model.Class` per entity (`Model.Sensitive` for hashes and secrets, so they are excluded from JSON variants by construction; `Model.UuidV7Insert` for ids) plus `SqlClient`/`SqlModel.makeRepository` for repository operations layered with `SqlSchema` queries, keyset pagination only (PRD §12). Migrations are v4 `Migrator` records exported per plugin; `Auth.make`'s linker orders and re-keys them (core first, then topological order, keys `NNNN_<plugin>_<name>`, per PRD §12 and `archive/design/plugins-as-layers.md` §1) and the SQL driver's stock migrator applies them at runtime. The snapshot-diff planner, checksum ledger, and destructive-change guardrails envisioned in `research/10-schema-migrations.md` are **retained as a design direction but relocated**: they become a future `@awthaq/cli` / `@awthaq/migration` feature (`auth migration generate`, drift detection, dry-run) layered on top of the runtime's `Model`/`Migrator` records, not a v1 runtime requirement (PRD §12: "Snapshot-diff planning with a checksum ledger and destructive-change guardrails (research 10) is a CLI feature layered on top, not a v1 runtime requirement").

## Alternatives considered

**A bespoke schema IR with a first-party diff planner as a core runtime dependency**, this project's own original design per `research/10-schema-migrations.md` Q73–Q76: a closed `ColumnType` union driving per-dialect DDL rendering, with a full planner (ledger, checksums, drift, dry-run, destructive-op confirmation) required before `Auth.make` could be considered complete. This was revised — not abandoned outright, since the planner idea survives as a CLI feature — once `Model.Class` + `SqlModel` made the "one definition, multiple derived artifacts" property of the IR redundant for the *runtime* half of the problem, and once it became clear that drift detection and destructive-change review are naturally *offline*, human-reviewed CLI operations rather than something the running application's Layer graph needs to carry.

## Consequences

**Positive**: Persistence code is dialect-neutral by construction (`Model.Class` + `SqlClient`, not hand-written per-dialect DDL); entity definitions are single-sourced between validation and persistence, eliminating an entire class of drift between "the schema the app validates against" and "the schema the database enforces"; the v1 runtime is materially smaller because it does not have to ship or maintain a bespoke IR-and-planner subsystem.

**Negative**: The stronger migration-safety guarantees `research/10-schema-migrations.md` called for (checksummed ledgers, drift detection, destructive-op guardrails) are not available at v1 runtime boot — an application composing `Auth.make`'s migrations gets ordering and determinism (via the `dependsOn`-derived topological sort) but not the full review/dry-run workflow until the CLI feature ships.

**Trade-off accepted**: The project defers a materially safer migration-review workflow to a future milestone in exchange for landing v1 on Effect's own `Model`/`SqlModel`/`Migrator` primitives rather than a bespoke IR that would need independent validation, dialect-rendering correctness, and long-term maintenance parallel to Effect's own evolving `Model` module.

Not yet implemented — see spec/roadmap.md for milestone.
