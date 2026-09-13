# 28 — knip + dependabot + provenance-publish workflow (wired, unrun)

**What to build:** CI gains a dead-export gate and dependency-update
automation, and a provenance-publish workflow exists and is correct but
is never triggered as part of this effort.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] knip configured and added as a `pnpm check` step (or equivalent),
      passing against current source — dead exports fixed or explicitly
      ignored, never the gate weakened to pass trivially
- [ ] `.github/dependabot.yml` configured for the workspace's package
      managers
- [ ] A provenance-publish GitHub Actions workflow exists, following
      `spec/process/definitions-of-done.md`'s already-committed plan
      (npm OIDC trusted publishing, no long-lived tokens) — wired but
      not run; no npm publish occurs as part of this ticket
- [ ] `check.yml` passes with the new knip step included
