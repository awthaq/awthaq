# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`spec/overview.md`** — this repo's `CONTEXT.md`-equivalent: mission, design philosophy, the package/stratum map, and the planned public API surface.
- **`spec/decisions/`** — this repo's `docs/adr`-equivalent: numbered ADRs (`ADR-EA-NNN`), one file per decision, indexed in `spec/decisions/index.yaml`.
- **`spec/behaviors/`** — numbered `BEH-EA-NNN` functional requirements, one file per feature area.
- **`spec/traceability.md`** — maps behavior ranges to the package/file that implements (or will implement) them.
- **`spec/roadmap.md`** — milestone sequencing and gate status.

This repo does **not** use a root `CONTEXT.md`/`CONTEXT-MAP.md` or a `docs/adr/`
directory, despite being a genuine monorepo (19 packages under `packages/*`):
its domain decisions and glossary are unified project-wide under `spec/`,
not split per package — an `ADR-EA-NNN` decision like authorization
delegation (ADR-EA-009) spans core, qadi, and client packages at once. Don't
create a parallel `CONTEXT.md`/`docs/adr/` alongside `spec/`; that would
duplicate an actively-maintained system with a second, competing one.

If `spec/` doesn't exist (e.g. this file is later reused as a template in a
different repo), proceed silently — don't flag its absence, don't suggest
creating it upfront.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `spec/overview.md` and `spec/behaviors/`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in `spec/` yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it — via `/wayfinder` or `/to-spec` — rather than silently inventing terminology).

## Flag ADR conflicts

If your output contradicts an existing ADR (`spec/decisions/*.md`), surface it explicitly rather than silently overriding:

> _Contradicts ADR-EA-009 (authorization delegated to qadi) — but worth reopening because…_

Every `spec/*.md` file carries a Document Control table (`Status`, `Change History`) — respect current `Status` (`Effective` vs. superseded) when citing it. The specification describes a project that is implemented but unpublished; a behavior's *Implementation* or *Deviation* note says where the code differs, and `spec/traceability.md` says which claims rest on a passing test.
