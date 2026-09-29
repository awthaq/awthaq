---
ID: "MTS-003"
Title: "knip blanket ignoreDependencies silences 5 of 21 workspaces"
Level: medium
Category: "dx"
Status: resolved
Package: "—"
Source: "knip.json:9"
Auditor: "monorepo-tooling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTS-003 — knip blanket ignoreDependencies silences 5 of 21 workspaces

`MEDIUM` · `dx` · `—` · reported by **Monorepo Tooling Specialist** (`monorepo-tooling-specialist`)

Status: **resolved**

## Summary

api-key, magic-link and two-factor each ignore 7 dependencies and cli ignores 8 — including `effect` itself — while their entire src is `export {}` (packages/api-key/src/index.ts:10), so their 5-6 declared @awthaq/* runtime dependencies are all unused by construction. Together with next's @awthaq/react ignore, roughly a quarter of the workspace has knip's unlisted/unused dependency analysis disabled. The smoke script's own comment argues stub manifests are kept publish-realistic, but that goal is met by fixing the manifests (stubs need at most `effect`), not by teaching knip to look away; as-is, a genuinely wrong dependency added to one of these five packages can never be flagged.

## Evidence

Source: `knip.json:9`

```
    "packages/api-key": {
      "ignoreDependencies": [
        "@awthaq/api",
```

## Recommended fix

Reduce stub package.json files to deps their placeholder actually needs (none or effect only) and delete the per-package ignore blocks, keeping knip strict for all 21 workspaces.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: monorepo build tooling
- Full dossier: [`monorepo-tooling-specialist`](../../.reports/monorepo-tooling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `workspace-roster-sync`. Evidence at HEAD ec065a7: `knip.json:9`. Fix: Trim the four stub manifests to what their `export {}` needs, drop next's unused @awthaq/react (or make it a peer if intentionally forwarded), and delete every per-package ignore block from knip.json. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Plan note (2026-09-29):** Mostly done by earlier programs: api-key, cli and next are real packages now and their knip.json ignore blocks are gone (next no longer declares @awthaq/react). Left open: packages/magic-link and packages/two-factor are still `export {}` stubs with blanket knip ignoreDependencies and full runtime dependency lists, and both belong to P15, which is building them right now. Once P15 lands real modules, delete their two knip.json blocks and let `pnpm workspace:sync` regenerate their tsconfig paths/references (the drift guard already prunes the stale edges).

**Resolved (2026-09-29):** Already satisfied by earlier programs: api-key, cli, next, magic-link and two-factor ignore blocks are gone; the only ignore left is the root's @arethetypeswrong/cli (scripts/package-smoke.mjs runs the attw bin by path; removing it makes knip report it as unused). Justification comment lives in package-smoke.mjs since knip.json is strict JSON and rejects a comment key. knip green.
