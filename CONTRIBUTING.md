# Contributing to effect-auth

Thanks for your interest in contributing. This document covers how the
repository is organized, how to get a working development environment, and
what's expected of a pull request.

## Project layout

This is a pnpm workspace of independently-versioned `@effect-auth/*`
packages under `packages/`, plus a Gherkin/BDD acceptance suite under
`features/`. The design is spec-first: `spec/` holds the normative
behavior specification (`spec/behaviors/`), architectural decisions
(`spec/decisions/`), and invariants (`spec/invariants.md`) that the source
under `packages/` implements. If you're adding or changing behavior, the
spec is the place to look first — and, for anything beyond a small fix,
the place to update alongside the code.

## Getting started

Requirements: Node.js 22.12+, [pnpm](https://pnpm.io) 11.20+.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm test:bdd
```

`pnpm check` runs the full local gate (typecheck, lint, format check,
circular-import check, coverage, BDD suite, and spec traceability
verification) — the same checks CI runs on every pull request.

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

## Commit and changeset conventions

This repository uses [Changesets](https://github.com/changesets/changesets)
to manage versioning and changelogs across the workspace. If your change
affects the published behavior of any `@effect-auth/*` package, add a
changeset describing it:

```sh
pnpm changeset
```

Follow the prompts to select the affected package(s) and describe the
change from a consumer's perspective — this text becomes the changelog
entry. A pull request that only touches internal tooling, tests, or
documentation generally doesn't need one.

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
