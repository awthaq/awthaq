# Definitions of Done
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-PROC-02 |
> | Revision | 1.2 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Process Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Noted that spec/scripts/verify-traceability.sh now exists and is runnable by hand; gate 9 itself remains not-yet-active pending CI (CCR-EA-002) <br> 1.2 (2026-09-12): Noted that a Gherkin acceptance suite now exists at features/features/*.feature (REQ-EA-001 through REQ-EA-602 allocated); distinguished this from the still-unbuilt testing harness that would execute it (CCR-EA-003) |
---

_Previous: [Requirement ID Scheme](./requirement-id-scheme.md)_

---

This document is **forward-looking**. No package, build, or CI exists yet in
this repository: there is no `package.json`, no lockfile, no git history, and
no workflow file. Every gate below is a plan for the milestone at which its
prerequisite first exists — see [`../roadmap.md`](../roadmap.md) for the
milestone definitions, reproduced here from `archive/PRD.md` §23 as: M0
Architecture, M1 Core, M2 Password, M3 qadi bridge, M4 OAuth/Passkey, M5
Client/React, M6 Tooling, M7 Phase-2 plugins, M8 Stable. Nothing in this
table is active today, and no "Active?" cell below claims otherwise.

## Merge gate (planned)

| # | Gate | What it verifies | Active? |
|---|---|---|---|
| 1 | Typecheck (`tsc`) | Sources compile | Not yet — planned for M0 |
| 2 | Lint (`oxlint` or equivalent) | Style and correctness lint is clean | Not yet — planned for M0 |
| 3 | House-style check | Project-specific conventions a linter cannot express (naming, forbidden patterns) | Not yet — planned for M0 |
| 4 | Circular-import check (`madge` or equivalent) | No circular imports across packages | Not yet — planned for M1 |
| 5 | Type-level compile-error tests | `Auth.make`'s `Validate<P>` produces the exact documented compiler errors for the missing-dependency, slot-conflict, and duplicate-id cases (a `tstyche`-equivalent type-testing tool) | Not yet — planned for M1 |
| 6 | Unit and integration tests | Tests pass, with a coverage threshold enforced rather than merely reported | Not yet — planned for M1 |
| 7 | Plugin contract-test harness | Every official plugin passes `runPluginContractTests`: manifest legality, table prefixes, migration determinism, redaction, veto-only-in-veto-points (see `research/09-plugin-architecture.md`) | Not yet — planned for M6 |
| 8 | Doc-example compilation | Every `typescript`/`tsx` fence in `spec/` compiles against the real API once one exists (today every fence in `spec/` is deliberately `ts` and uncompiled — this gate is what will let some of them graduate) | Not yet — planned for M6 |
| 9 | Traceability verification | Spec-internal consistency: every `index.yaml` matches its directory, every cross-reference resolves, every `INV`/`ADR`/`BEH` identifier is reachable from a traceability document | Not yet — planned for M6 |
| 10 | API-surface-vs-source check | `spec/overview.md`'s planned surface tables match the real exports once packages exist | Not yet — planned for M6 |
| 11 | Packed-tarball install check | Published packages actually install and resolve through their `exports` maps | Not yet — planned for M8 |
| 12 | Changesets and npm provenance | Release process integrity: lockstep versioning, OIDC trusted publishing, Sigstore provenance (see `research/12-library-strategy.md`) | Not yet — planned for M8 |
| 13 | Security review checklist | Secure defaults, redaction, session and token abuse cases (see `archive/PRD.md` §§18–19) | Not yet — planned for M8 |
| 14 | Real consumer app check | A reference Next.js (or similar) app using the published packages type-checks, builds, and passes its own tests | Not yet — planned for M8 |

## Notes on the not-yet-active gates

**Gate 5** exists because the entire selling point of `Auth.make`'s plugin
composition is that a missing dependency, a slot conflict, or a duplicate
plugin id fails to *compile*, not merely to run — see M0's roadmap entry
("a toy plugin compiles, a missing dependency fails to compile") in
`archive/PRD.md` §23. A type-level assertion tool is the only way to gate that
claim mechanically rather than by a reviewer reading a compiler error by eye
each time it changes.

**Gate 7** cites `research/09-plugin-architecture.md`'s recommendation
directly: `runPluginContractTests` is awthaq's analog of ESLint's
`RuleTester` — it asserts the compiler-facing contract (id namespace and
`apiVersion` legality, route and schema-IR validity including table
prefixes, migration determinism across two compiles, hook classification so
a veto-capable hook cannot appear outside a veto point, and redaction
defaults for anything a plugin emits into spans or events). Every official
plugin is required to pass it in CI once M6 lands; a plugin whose published
contract run fails is not eligible for the official registry.

**Gate 12** cites `research/12-library-strategy.md`'s recommendation to
follow Effect's own release template: pnpm workspaces, changesets with a
fixed version group so all `@awthaq/*` packages move in lockstep, and
publishing exclusively through npm trusted publishing (OIDC, `id-token:
write`, no stored long-lived tokens) so that Sigstore provenance is attached
automatically. Classic npm tokens were revoked ecosystem-wide in December
2025; this gate exists so that release integrity is never re-litigated by
hand at ship time.

**Gate 9** now has a script — [`spec/scripts/verify-traceability.sh`](../scripts/verify-traceability.sh),
modeled directly on qadi's own `spec/scripts/verify-traceability.sh` — that
a contributor can already run by hand (`bash spec/scripts/verify-traceability.sh`)
today, before M6. What is "Not yet — planned for M6" is the gate, not the
script: nothing yet invokes this script automatically on merge, because there
is no CI, no `package.json`, and no workflow file for a gate to live in. See
[`requirement-id-scheme.md` §4](./requirement-id-scheme.md#4-cross-reference-syntax).
The script's check 4 (`features -> traceability`), which previously SKIPped
for lack of a `features/` directory, now runs for real: a Gherkin acceptance
suite exists at `features/features/*.feature` (`REQ-EA-001` through
`REQ-EA-602`, see [`../traceability.md` §6](../traceability.md#6-acceptance-scenarios-req-ea)),
so this is the first of the fourteen gates above to have real, checkable
content behind it pre-M6 — though only as a hand-run check, and only of the
suite's own internal consistency, not of anything the suite asserts actually
holding at runtime (there is still no step-definition layer or Cucumber
configuration; see the per-change checklist item below).

## What this table is not

This table is not itself wired to anything: there is no `pnpm check`, no
`.github/workflows/check.yml`, and no script that verifies this table matches
a real command chain, because none of those exist to drift from yet. When CI
is introduced, it should run exactly this gate list and nothing else — one
command, one definition of "done" — so that a second, informally-maintained
notion of "done" never grows up alongside it. That is the discipline qadi's
own `pnpm check` and `definitions-of-done.md` follow, and this document exists
so awthaq adopts it from the first commit rather than retrofitting it
after gates have already drifted from what CI actually runs.

## Per-change checklist (planned)

- [ ] Behavior change is reflected in the relevant `behaviors/*.md`.
- [ ] A new constraint has an invariant in `invariants.md` naming its planned enforcement mechanism.
- [ ] A new design choice with a real alternative has an ADR.
- [ ] New identifiers appear in the relevant directory's `index.yaml`.
- [ ] Coverage thresholds, once configured, are still met.
- [ ] New user-visible behavior has a `Scenario:`/`Scenario Outline:` in the matching `features/features/*.feature` file, tagged with a new `REQ-EA-NNN` (run `features/scripts/allocate-req-ea.py` to allocate it and refresh `features/traceability.md` — do not hand-assign a number).
