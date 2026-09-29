---
ID: "MM-006"
Title: "Privileged release workflow uses tag-pinned actions while check.yml pins SHAs"
Level: medium
Category: "compliance"
Status: ready-for-agent
Package: "—"
Source: ".github/workflows/release.yml:32"
Auditor: "mattia-manzati"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MM-006 — Privileged release workflow uses tag-pinned actions while check.yml pins SHAs

`MEDIUM` · `compliance` · `—` · reported by **Mattia Manzati — Effect Developer Tooling** (`mattia-manzati`)

Status: **ready-for-agent**

## Summary

check.yml pins every third-party action by full commit SHA; release.yml pins by mutable tag (`actions/checkout@v5`, `pnpm/action-setup@v4`, `actions/setup-node@v5`, `changesets/action@v1`). release.yml is the more sensitive workflow: it runs with `contents: write` and `id-token: write` (npm OIDC trusted publishing), so a retargeted tag on any of these actions executes attacker code inside the publishing context — the exact supply-chain scenario the repo's zizmor workflow and gate 12's 'no long-lived tokens' posture exist to prevent. The asymmetry looks like an oversight, not a decision: the OIDC comments are careful, the pinning is not.

## Evidence

Source: `.github/workflows/release.yml:32`

```
      - uses: actions/checkout@v5
```

## Recommended fix

Pin all release.yml actions to the same full SHAs check.yml uses (with version comments), and add zizmor to run on release.yml too if it currently scopes only to check.yml.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 80/100), domain: dev tooling
- Full dossier: [`mattia-manzati`](../../.reports/mattia-manzati/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 33 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`MW-005` — Zero published artifacts: release pipeline designed and wired but never exercised](medium/MW-005-matias-woloski.md) `_(matias-woloski, medium)_`
- [`MTS-006` — Release workflow drops the SHA-pinning discipline while holding the most privileges](medium/MTS-006-monorepo-tooling-specialist.md) `_(monorepo-tooling-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `ci-release-hardening`. Evidence at HEAD ec065a7: `.github/workflows/release.yml:32`. Fix: SHA-pin every action in release.yml (reuse check.yml's SHAs; resolve changesets/action's v1 tag to a commit), make zizmor enforce hash-pinning repo-wide, and gate release on a green Check run. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
