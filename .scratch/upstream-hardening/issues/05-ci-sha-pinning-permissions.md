# CI Action SHA-pinning + least-privilege `permissions:` on `check.yml`

Type: grilling
Status: resolved

## Question

`check.yml` uses tag refs (e.g. `actions/checkout@v5`), not SHA-pins, and
has no `permissions:` block — confirmed by direct read. `release.yml`
already has both a SHA-pinning-adjacent posture(check exact state) and an
explicit least-privilege `permissions:` block, so there's an existing
in-repo pattern to match.

Decide: SHA-pinning without an update mechanism goes stale — does this
lean on the already-present Dependabot (`shipping-gaps` ticket 06 added
it) to bump pinned SHAs via its `github-actions` ecosystem support, or
does something else keep them current?; the exact `permissions:` scope
per job in `check.yml` (mirror `release.yml`'s least-privilege shape or
derive fresh from what each job actually touches); and whether this
should be one ticket or two given `shipping-gaps` already touched this
workflow file for knip/dependabot in ticket 06 — check for merge risk
against that ticket's diff before starting.

## Answer

Grounded against direct reads of both `.github/workflows/check.yml` and
`release.yml`, plus `.github/dependabot.yml`.

**Correction to this ticket's own framing: `release.yml` doesn't
SHA-pin anything either** — `actions/checkout@v5`, `pnpm/action-setup@v4`,
`actions/setup-node@v5`, `changesets/action@v1` are all plain tag refs
there too. It only has the `permissions:` block. There's no existing
pinned-action pattern anywhere in this repo to copy — every SHA below
was resolved fresh via `git ls-remote --tags` against each action's
public repo (dereferencing annotated tags to their real commit SHA,
never the tag object's own SHA):

- `actions/checkout@v5` → `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09`
- `pnpm/action-setup@v4` → `b906affcce14559ad1aafd4ab0e942779e9f58b1`
- `actions/setup-node@v5` → `a0853c24544627f65ddf259abe73b1d18a591444`
- `changesets/action@v1` → `a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d`
  (`refs/heads/v1`, currently identical to the latest `v1.9.0` tag —
  `changesets/action` has no plain `v1` *tag*, only a moving branch alias)

Each pin gets the standard trailing `# vX.Y.Z` comment (`uses:
actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5`) —
Dependabot's `github-actions` ecosystem parses that comment to know what
it's bumping.

**Update mechanism — the already-present Dependabot, no new mechanism
needed.** `.github/dependabot.yml` already has a `github-actions`
ecosystem entry (weekly), confirmed by direct read — it was already
positioned to keep SHA-pins current the moment any exist; nothing to add.

**`permissions:` — `contents: read` only, workflow-level, not
`release.yml`'s shape.** `check.yml`'s single job only checks out code,
installs deps, and runs `pnpm check` (typecheck/lint/knip/format/
circular/coverage/BDD/spec-traceability) — it never writes to the repo,
opens a PR, or publishes anything, so it needs none of `release.yml`'s
`contents: write`/`pull-requests: write`/`id-token: write`. Set at
workflow level (matching `release.yml`'s own placement), not per-job —
there's only one job.

**One ticket, no merge risk.** `shipping-gaps` ticket 06's own CI
changes are already fully merged and already reflected in the
`check.yml` this ticket read directly (`pnpm check`'s script composition
already includes `knip`) — nothing stale to reconcile against. This
ticket's change (pin 4 actions, add a 2-line permissions block) is
small and cohesive enough to stay one ticket.
