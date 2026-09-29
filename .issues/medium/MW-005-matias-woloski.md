---
ID: "MW-005"
Title: "Zero published artifacts: release pipeline designed and wired but never exercised"
Level: medium
Category: "dx"
Status: ready-for-human
Package: "—"
Source: ".github/workflows/release.yml:4"
Auditor: "matias-woloski"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MW-005 — Zero published artifacts: release pipeline designed and wired but never exercised

`MEDIUM` · `dx` · `—` · reported by **Matias Woloski — Co-founder/former CTO of Auth0** (`matias-woloski`)

Status: **ready-for-human**

## Summary

The publish tooling is unusually mature for pre-release (changesets, npm OIDC trusted publishing with no stored tokens, per-package npm pack + publint + attw in scripts/package-smoke.mjs), but all 21 packages are private and the workflow's own header admits it has never run. Unexercised release pipelines fail in exactly the ways static checks cannot see (OIDC registration, provenance, registry-side rejects), and an SDK's first consumers cannot exist until at least one artifact ships.

## Evidence

Source: `.github/workflows/release.yml:4`

```
not run as part of this ticket. Every `@awthaq/*` package is still
# `"private": true`, so `changeset publish` has nothing publishable yet;
```

## Recommended fix

Publish one leaf package (e.g. @awthaq/ports) through the existing pipeline to prove OIDC + provenance + attw end-to-end, then roll the remaining packages out behind the same changesets flow.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: engineering-scale posture
- Full dossier: [`matias-woloski`](../../.reports/matias-woloski/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`MM-006` — Privileged release workflow uses tag-pinned actions while check.yml pins SHAs](medium/MM-006-mattia-manzati.md) `_(mattia-manzati, medium)_`
- [`MTS-006` — Release workflow drops the SHA-pinning discipline while holding the most privileges](medium/MTS-006-monorepo-tooling-specialist.md) `_(monorepo-tooling-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `ci-release-hardening`. Evidence at HEAD ec065a7: `.github/workflows/release.yml:4`. Fix: Make the pipeline actually publishable, then exercise it with one canary leaf package once the human-only prerequisites (git remote + npm trusted publisher) exist. (effort M). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-human.

**Plan note (2026-09-29):** Decision (2026-09-29): adopted recommended option A per plan; user may revisit. Agent-side prep done: changeset `access` is public (packages are still private:true, so nothing can publish by accident), the fixed group covers all 25 packages and is now kept in sync by `pnpm workspace:check`, `pnpm release:dry-run` (changeset status + pnpm publish --dry-run per non-private package) exists, release.yml is SHA-pinned/least-privilege/gated on Check (MM-006), and .github/workflows/canary.yml is the dormant canary publish of @awthaq/ports (workflow_dispatch only, guarded by the AWTHAQ_CANARY_ENABLED repository variable and a protected `npm-canary` environment, provenance on). Still open, all human: a remote for this repository, the @awthaq npm organisation, a trusted publisher for @awthaq/ports naming canary.yml, dropping private:true from @awthaq/ports, setting AWTHAQ_CANARY_ENABLED, running the workflow, then verifying `npm view @awthaq/ports dist.attestations` and attw against the registry copy. The README 'Publishing status' text belongs to the docs work.
