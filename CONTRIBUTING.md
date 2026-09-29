# Contributing to awthaq

Thanks for your interest in contributing. This document covers how the
repository is organized, how to get a working development environment, and
what's expected of a pull request.

## Project layout

This is a pnpm workspace of independently-versioned `@awthaq/*`
packages under `packages/`, plus a Gherkin/BDD acceptance suite under
`features/`. The design is spec-first: `spec/` holds the normative
behavior specification (`spec/behaviors/`), architectural decisions
(`spec/decisions/`), and invariants (`spec/invariants.md`) that the source
under `packages/` implements. If you're adding or changing behavior, the
spec is the place to look first — and, for anything beyond a small fix,
the place to update alongside the code.

## Getting started

Requirements: Node.js 22.18+ for development (pnpm 11.20 needs 22.13 and the oxlint plugin in `tools/oxc` is TypeScript, which Node runs unflagged from 22.18; the published packages still support 22.12), [pnpm](https://pnpm.io) 11.20+.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm test:bdd
```

`pnpm check` runs the full local gate: the package-roster drift check
(`workspace:check`), typecheck, the packed-package smoke test, lint, knip,
format check, the circular-import check (value and type-level cycles),
README and error-tag checks, coverage against its thresholds, the BDD
suite, and spec traceability verification. It is the same set CI runs on
every pull request.

Adding a package: create `packages/<name>/` and run `pnpm workspace:sync`,
which regenerates the `tsconfig` path and reference lists and the changeset
version group from `packages/*/package.json`. `pnpm workspace:check` (part of
`pnpm check`) fails when any of them, or the root README's package list, has
drifted.

## Making a change

- Keep pull requests focused. A bug fix doesn't need an accompanying
  refactor; a new capability doesn't need to touch unrelated packages.
- Follow the conventions already established in the package you're
  touching — most files carry a header comment explaining *why* a
  non-obvious choice was made, which is usually the fastest way to learn
  the local style.
- Add or update tests alongside the change. Prefer the same seam existing
  tests in that package already use (see each package's `test/` directory)
  over inventing a new one.
- Run `pnpm typecheck`, `pnpm lint`, `pnpm format`, and `pnpm test` before
  opening a pull request. `pnpm check` runs everything CI does, including
  the BDD suite and spec traceability check.

## The quality dashboard (local only)

`node scripts/generate-quality-dashboard.mjs` renders `type-quality-dashboard.html`
from per-package KPI JSON files in `.quality-metrics/`. Both are gitignored and
nothing in `pnpm check` uses them; the script's header documents the JSON contract.
The renderer refuses metrics that no longer describe the code (a `sourceSha` older than
a change under the package's `src/`, a file or line count that differs from the live
tree, an unknown package), so stale numbers cannot be rendered silently. The
type-safety rules that matter (`as`, `any`) are lint rules, not dashboard KPIs.

## Bumping the `effect` release candidate

`effect` is pinned exact in `pnpm-workspace.yaml`'s catalog. Comments and docs
must not repeat that version (they go stale — MTS-008); refer to "the
catalog-pinned `effect`" instead. After a bump this must print nothing:

```sh
grep -rnE 'rc\.[0-9]+' packages --include='*.ts' --include='*.tsx' | grep -v -e /lib/ -e node_modules
```

## Commit and changeset conventions

This repository uses [Changesets](https://github.com/changesets/changesets)
to manage versioning and changelogs across the workspace. All packages are
one fixed version group. A pull request that changes anything under
`packages/` needs a changeset; CI runs `changeset status` and fails without
one:

```sh
pnpm changeset
```

Follow the prompts to select the affected package(s) and describe the
change from a consumer's perspective: this text becomes the changelog
entry. A change with no release impact (tooling, tests, documentation)
answers with `pnpm changeset --empty`.

### Versioning and deprecation policy (ADR-EA-034)

Three things are the public surface: the `Schema` shapes that cross a
package boundary or the wire, the `HttpApi` contract (paths, status codes,
error tags), and the `Layer`/`Service` signatures. A change is *additive*
(new optional field, endpoint, member or export), *compatible* (a fix no
correct caller observes) or *breaking* (anything else, including a new
requirement on a layer that composed before).

- **Before 1.0, breaking changes are allowed in any release.** Each one has
  a changeset whose body includes a `Migration:` section: what a consumer
  must change, and the ADR-EA/BEH-EA ids involved. There is no deprecation
  window and no runtime warning; product value wins over API stability while
  there are no consumers.
- **From 1.0, a break needs a major version**, after the behavior has been
  marked `@deprecated` in JSDoc (with its replacement) and logged once with
  `Effect.logWarning` at layer build for at least one minor release.
- **An `effect` release-candidate bump that changes a public type counts as
  breaking**, and is announced the same way.

## Pull requests

- Describe what changed and why, not just what — the "why" is what a
  reviewer (and future you) actually needs.
- Link the relevant `spec/behaviors/` entry or ticket if one exists.
- Expect CI to run the full merge gate described in
  `spec/process/definitions-of-done.md`. A pull request that doesn't pass
  it won't be merged.

## Reporting bugs and requesting features

Open an issue with a clear description and, for a bug, a minimal
reproduction. For security vulnerabilities, see [SECURITY.md](./SECURITY.md)
instead of opening a public issue.

## Code of conduct

Be respectful and constructive. This project doesn't yet have a separate
code-of-conduct document; until it does, the standard expectation applies:
no harassment, no personal attacks, and disagreements stay about the code.
