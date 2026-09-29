---
ID: "AVS-009"
Title: "No deprecation/breaking-change policy; versioning tooling wired but never exercised"
Level: medium
Category: "dx"
Status: ready-for-human
Package: "—"
Source: "CONTRIBUTING.md:50"
Auditor: "api-design-versioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AVS-009 — No deprecation/breaking-change policy; versioning tooling wired but never exercised

`MEDIUM` · `dx` · `—` · reported by **API Design & Versioning Specialist** (`api-design-versioning-specialist`)

Status: **ready-for-human**

## Summary

The mechanics exist (fixed lockstep group across all 21 packages, `privatePackages: { version: true }`), but `.changeset/` contains only config.json — zero changesets have ever been authored — and every package sits at its bootstrap 0.1.0, so the discipline is unproven. More importantly, nothing in CONTRIBUTING, spec/decisions/, or package sources (grep for `deprecat` returns only unrelated hits) defines how a breaking change is classified, warned, or scheduled — despite ADR-EA-003's own accepted trade-off that a breaking change to Effect's unstable HttpApi is a breaking change to every plugin contract. "Pre-1.0" without a stated policy is exactly the red flag this domain flags: consumers of an rc-pinned dependency need to know what migration window they get.

## Evidence

Source: `CONTRIBUTING.md:50`

```
This repository uses [Changesets](https://github.com/changesets/changesets) to manage versioning and changelogs across the workspace. If your change affects the published behavior of any `@awthaq/*` package, add a changeset describing it:
```

## Recommended fix

Write the policy down now, while it costs nothing: additive vs compatible vs breaking classification for Schema shapes, endpoint paths, and Layer signatures; a deprecation window (e.g. one minor release with runtime warnings via Effect's deprecated-annotation or log warning) before removal; and a rule that every breaking change ships a changeset with a migration note tied to the relevant ADR.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 63/100), domain: API surface & versioning
- Full dossier: [`api-design-versioning-specialist`](../../.reports/api-design-versioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `ci-release-hardening`. Evidence at HEAD ec065a7: `CONTRIBUTING.md:48`. Fix: Write a versioning & deprecation policy (pre-1.0 and post-1.0 rules) into CONTRIBUTING.md plus a short ADR, and make changesets mandatory for package-affecting PRs. (effort S). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-human.
