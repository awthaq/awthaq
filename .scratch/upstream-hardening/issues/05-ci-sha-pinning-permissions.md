# CI Action SHA-pinning + least-privilege `permissions:` on `check.yml`

Type: grilling
Status: open

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
