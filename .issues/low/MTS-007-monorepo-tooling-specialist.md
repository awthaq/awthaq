---
ID: "MTS-007"
Title: "minimumReleaseAgeExclude block configures exclusions for a gate that is not enabled"
Level: low
Category: "compliance"
Status: wontfix
Package: "—"
Source: "pnpm-workspace.yaml:38"
Auditor: "monorepo-tooling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTS-007 — minimumReleaseAgeExclude block configures exclusions for a gate that is not enabled

`LOW` · `compliance` · `—` · reported by **Monorepo Tooling Specialist** (`monorepo-tooling-specialist`)

Status: **wontfix**

## Summary

Twelve lines of minimumReleaseAgeExclude entries exist, but no `minimumReleaseAge` setting is present anywhere — pnpm-workspace.yaml has no such key and there is no .npmrc at the repo root — so the exclude list currently guards nothing. Either the release-age supply-chain delay was disabled at some point and the excludes were left behind, or the base setting was never added; in both cases the file signals a protection (freshly-published rc versions held back for a cool-off) that a reader cannot verify is active, which matters for a repo whose whole pinning strategy hinges on pulling rc builds.

## Evidence

Source: `pnpm-workspace.yaml:38`

```
minimumReleaseAgeExclude:
  - "@effect-cucumber/gherkin@0.10.1"
  - "@effect-cucumber/vitest@0.10.1"
```

## Recommended fix

Set the intended `minimumReleaseAge` (e.g. 1440 minutes) next to the excludes, or delete the block and note in the catalog comment why no release-age gate applies.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: monorepo build tooling
- Full dossier: [`monorepo-tooling-specialist`](../../.reports/monorepo-tooling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** INVALID (confidence high); workstream `None`. Evidence at HEAD ec065a7: `package.json:52`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/13-repo-features-tooling.md`.

**Wontfix (2026-09-29):** Invalid. `packageManager` is pnpm@11.20.0, whose default `minimumReleaseAge` is 1440 minutes (pnpm CHANGELOG: 'Changed default values … minimumReleaseAge is now 1440'); in the default loose mode pnpm itself auto-writes immature picks into `minimumReleaseAgeExclude` in pnpm-workspace.yaml. The block is that auto-maintained list and the gate is active. Adding a static comment would be rewritten by pnpm and would collide with the qadi bump that edits the same block. To make the gate strict, a user sets `minimumReleaseAgeStrict: true`.
