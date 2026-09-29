# Definitions of Done
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-PROC-02 |
> | Revision | 1.3 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Process Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Noted that spec/scripts/verify-traceability.sh now exists and is runnable by hand; gate 9 itself remains not-yet-active pending CI (CCR-EA-002) <br> 1.2 (2026-09-12): Noted that a Gherkin acceptance suite now exists at features/features/*.feature (REQ-EA-001 through REQ-EA-602 allocated); distinguished this from the still-unbuilt testing harness that would execute it (CCR-EA-003) <br> 1.3 (2026-09-29): Replaced the forward-looking "nothing exists" framing with the real state: added a "Wired as" column mapping each gate to its `pnpm check` step (or "Not wired"), flipped Active? to the truth, removed the claims that no `package.json`, CI or runner exists, and added the per-change rules for inventories and the acceptance manifest; `spec/scripts/check-drift.mjs` fails a gate marked Active whose command is not in `pnpm check` (MM-005, DTWS-005, DTWS-006, AVS-008, CCR-EA-006) |
---

_Previous: [Requirement ID Scheme](./requirement-id-scheme.md)_

---

This document defines "done" for awthaq and records which gates are actually
enforced. The repository has a root `package.json`, a lockfile, and
`.github/workflows/check.yml`, which runs `pnpm check` on every pull request
and push to `main`; `.github/workflows/release.yml` carries the release
process. `pnpm check` is the one command that runs the gates below, and it is
the only definition of "done" — see [`../roadmap.md`](../roadmap.md) for the
milestones (M0 Architecture through M8 Stable, reproduced from `archive/PRD.md`
§23) the gates certify. The **Wired as** column below says exactly which step of
`pnpm check` implements each gate, or that none does: a gate that is "Not
wired" is a plan, not a check, and no cell claims otherwise.

## Merge gate

| # | Gate | What it verifies | Active? | Wired as |
|---|---|---|---|---|
| 1 | Typecheck (`tsc`) | Sources and tests compile | Active | `pnpm typecheck` (`tsc -b tsconfig.json && tsc -p tsconfig.test.json`) |
| 2 | Lint (`oxlint`) | Style and correctness lint is clean, including the project's own Effect rules in `tools/oxc` (no type assertions in `packages/*/src`) | Active | `pnpm lint` |
| 3 | House-style check | Project-specific conventions a linter cannot express | Active-partial | `pnpm check:error-tags` (`scripts/check-error-tags.mjs`: internal and wire error tags never collide, no untagged defect) and `pnpm check:readmes` (`scripts/check-readme-status.mjs`); naming conventions are not mechanized |
| 4 | Circular-import check (`madge`) | No circular imports across packages | Active | `pnpm circular` (`scripts/circular.mjs`; `import type` edges count too) |
| 5 | Type-level compile-error tests | `Auth.make`'s `Validate<P>` produces the documented compiler errors for the missing-dependency, slot-conflict, and duplicate-id cases | Active-partial | `pnpm typecheck` compiles the `@ts-expect-error` cases in `packages/core/test/AuthPlugin.test.ts` and `HookPoint.types.test.ts`; there is no dedicated type-testing tool (`tstyche`), so a wrong-error-message regression is not caught |
| 6 | Unit and integration tests | Tests pass, with a coverage threshold enforced rather than merely reported | Active | `pnpm coverage` runs the whole vitest suite under v8 coverage and fails below the thresholds in `vitest.config.ts` (workspace-wide floors plus stricter floors for `core`, `password`, `jwt` and `server`) |
| 7 | Plugin contract-test harness | Every official plugin passes `runPluginContractTests`: manifest legality, table prefixes, redaction, veto-only-in-veto-points (see `research/09-plugin-architecture.md`) | Active-partial | `pnpm coverage` runs it for `admin`, `jwt`, `organization` and `examples/plugin-template`; `password`, `oauth`, `passkey`, `api-key`, `roles` and `scim` do not call it yet |
| 8 | Doc-example compilation | Every `typescript`/`tsx` fence in `spec/` compiles against the real API (today every fence in `spec/` is deliberately `ts` and uncompiled; check 6 of `verify-traceability.sh` forbids a compiled-language fence there) | Active-partial | The root `README.md` quickstart is compiled: `pnpm typecheck` compiles `packages/sql/test/fixtures/readme-quickstart.ts` and `pnpm coverage` runs `packages/sql/test/ReadmeQuickstart.test.ts`, which fails if the README block and the fixture differ; the `spec/` fences are not compiled |
| 9 | Traceability verification | Spec-internal consistency: every `index.yaml` matches its directory, every cross-reference resolves, every `INV`/`ADR`/`BEH` identifier is reachable from a traceability document, cited test paths exist, the acceptance manifest is current, and no `REQ-EA` id is claimed twice | Active | `pnpm spec:verify:strict` (`spec/scripts/verify-traceability.sh` and `spec/scripts/check-drift.mjs`) |
| 10 | API-surface-vs-source check | The surface tables in the spec match the real exports | Active-partial | `pnpm spec:verify:strict` diffs [ADR-EA-003](../decisions/003-httpapi-as-contract.md)'s core HttpApi inventory against `packages/api/src` and `spec/overview.md`'s Ports module list against `packages/ports/src/index.ts`; the other surface tables (domain, qadi bridge, plugins) are reconciled by hand |
| 11 | Packed-tarball install check | Packages assemble, their `package.json` is publish-correct, and their types resolve through the `exports` map | Active | `pnpm package:smoke` (`scripts/package-smoke.mjs`: `npm pack --dry-run`, `publint`, `@arethetypeswrong/cli`) |
| 12 | Changesets and npm provenance | Release process integrity: lockstep versioning, OIDC trusted publishing, Sigstore provenance (see `research/12-library-strategy.md`) | Active (no-op while every package is private) | `.github/workflows/release.yml` (changesets/action, `id-token: write`) |
| 13 | Security review checklist | Secure defaults, redaction, session and token abuse cases (see `archive/PRD.md` §§18–19) | Not wired | none; `SECURITY.md` describes the policy, no checklist is run |
| 14 | Real consumer app check | A reference Next.js (or similar) app using the *published* packages type-checks, builds, and passes its own tests | Not wired | none; `examples/memory-server` is workspace-linked, type-checked and smoke-tested, which is a proxy, not this gate |

Also in `pnpm check`, outside the fourteen: `pnpm workspace:check` (`scripts/sync-workspace.mjs`: the package roster in the tsconfigs, changesets, vitest projects, knip and the README all agree with `packages/`), `pnpm knip` (unused files, exports and dependencies), `pnpm format:check` (`oxfmt`) and `pnpm test:bdd` (the Gherkin acceptance suite, `features/`, wired feature files only).

## Notes on the gates

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

**Gate 9** is [`spec/scripts/verify-traceability.sh`](../scripts/verify-traceability.sh),
modeled directly on qadi's own `spec/scripts/verify-traceability.sh`, plus the
Node checks in [`spec/scripts/check-drift.mjs`](../scripts/check-drift.mjs). It is
in `pnpm check` (as `pnpm spec:verify:strict`), so CI runs it. Beyond
structure (indexes, links, anchors, id integrity) it fails on: a present-tense
"nothing is built" claim, a cited test path that does not exist (or a "no test
exists yet" cell naming one that does), a gate marked Active below whose
command is not a script in the `pnpm check` chain, a Document Control
`Revision` behind its own Change History, a stale acceptance manifest, and a
`REQ-EA` id claimed by two scenarios. See
[`requirement-id-scheme.md` §4](./requirement-id-scheme.md#4-cross-reference-syntax).
What it still cannot check is whether a claim in `spec/` is true of running
code: the acceptance suite is wired only for the session, password, OAuth,
passkey and admin-impersonation feature files (see the per-change checklist
item below), and each behavior's tests are cited, not re-run, by this script.

## What this table is not

This table is not a second, informally-maintained notion of "done": CI runs
`pnpm check` and nothing else, so this list and that chain must agree. The
"Wired as" column is the agreement, and gate 9's script enforces one direction
of it (an Active gate must name a command that exists and runs in
`pnpm check`). The other direction, that no step in `pnpm check` goes
unlisted, is kept by hand, which is why the extra steps are named above. That
is the discipline qadi's own `pnpm check` and `definitions-of-done.md` follow.

## Per-change checklist

- [ ] Behavior change is reflected in the relevant `behaviors/*.md`.
- [ ] A new constraint has an invariant in `invariants.md` naming its enforcement mechanism and the test that exercises it (or saying plainly that none does).
- [ ] A new design choice with a real alternative has an ADR.
- [ ] New identifiers appear in the relevant directory's `index.yaml`.
- [ ] Coverage thresholds, once configured, are still met.
- [ ] Adding, renaming or removing an `HttpApiGroup` or endpoint in `packages/api`, or a module in `packages/ports/src/index.ts`, updates the matching inventory in the same change (ADR-EA-003's `surface:api` block, `overview.md`'s `surface:ports` block); `pnpm spec:verify:strict` fails otherwise.
- [ ] A behavior or test moves, appears or disappears: the `traceability.md` row that cites it is updated in the same change, and a cell that cites a test path names one that exists.
- [ ] New user-visible behavior has a `Scenario:`/`Scenario Outline:` in the matching `features/features/*.feature` file, tagged with a new `REQ-EA-NNN` (run `python3 features/scripts/allocate-req-ea.py` to allocate it and regenerate `features/traceability.md`, and commit the result — do not hand-assign a number; `pnpm spec:verify:strict` fails on a stale manifest or a duplicated id).
