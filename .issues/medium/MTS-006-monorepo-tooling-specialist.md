---
ID: "MTS-006"
Title: "Release workflow drops the SHA-pinning discipline while holding the most privileges"
Level: medium
Category: "security"
Status: resolved
Package: "—"
Source: ".github/workflows/release.yml:45"
Auditor: "monorepo-tooling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTS-006 — Release workflow drops the SHA-pinning discipline while holding the most privileges

`MEDIUM` · `security` · `—` · reported by **Monorepo Tooling Specialist** (`monorepo-tooling-specialist`)

Status: **resolved**

## Summary

check.yml (lines 44-46) and zizmor.yml (lines 22-23) pin every action to a full commit SHA with a version comment, but release.yml — the only workflow with `contents: write` plus `id-token: write` for npm OIDC trusted publishing — pins all four actions by mutable tag: checkout@v5 (line 32), pnpm/action-setup@v4 (35), setup-node@v5 (36), changesets/action@v1 (45). A compromised upstream tag executes with publish capability to the npm registry. The repo's own zizmor workflow scans .github/workflows, so the inconsistency is visible to its own tooling; the privilege asymmetry makes this the one file where pinning matters most.

## Evidence

Source: `.github/workflows/release.yml:45`

```
      - name: Version or publish
        uses: changesets/action@v1
```

## Recommended fix

Pin all four release.yml actions to the same commit SHAs used elsewhere, with version comments; consider gating `changeset-publish` on the check workflow succeeding (e.g. workflow_run or a needs: check job) so a red main cannot mint version PRs/publishes.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: monorepo build tooling
- Full dossier: [`monorepo-tooling-specialist`](../../.reports/monorepo-tooling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`MW-005` — Zero published artifacts: release pipeline designed and wired but never exercised](medium/MW-005-matias-woloski.md) `_(matias-woloski, medium)_`
- [`MM-006` — Privileged release workflow uses tag-pinned actions while check.yml pins SHAs](medium/MM-006-mattia-manzati.md) `_(mattia-manzati, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `ci-release-hardening`. Duplicate of `MM-006` — closed by that issue's fix. Evidence at HEAD ec065a7: `.github/workflows/release.yml:44`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `MM-006-mattia-manzati` — closed by its fix (see that issue's Resolved comment).
