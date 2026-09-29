---
ID: "ECS-004"
Title: "CLI command framework unpinned; stale @effect/cli guidance persists"
Level: medium
Category: "architecture"
Status: ready-for-agent
Package: "cli"
Source: "packages/cli/package.json:40"
Auditor: "effect-cli-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECS-004 — CLI command framework unpinned; stale @effect/cli guidance persists

`MEDIUM` · `architecture` · `cli` · reported by **Effect CLI Specialist** (`effect-cli-specialist`)

Status: **ready-for-agent**

## Summary

The repo pins effect 4.0.0-rc.116, where no @effect/cli 4.x exists; the v4 CLI lives in-core under `effect/unstable/cli` (research/19-dbc-to-effect-mapping.md:231). Yet research/12-library-strategy.md:13 still advises 'Build the MVP CLI on `@effect/cli`' - an Effect-3-only package (peers effect ^3.22.2) - and no ADR records the actual choice. Depending on an `unstable/` export without a recorded decision and a port seam is risky for an operator-facing binary whose CLI flags are a public contract.

## Evidence

Source: `packages/cli/package.json:40`

```
"effect": "catalog:"
```

## Recommended fix

Write an ADR pinning `effect/unstable/cli` as the parser with a thin command-function seam (each command = a function taking typed args) so wiring churn between RCs stays isolated from command logic; correct research/12's superseded recommendation and the stale @effect/cli mention in .scratch analysis.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Operator CLI tooling
- Full dossier: [`effect-cli-specialist`](../../.reports/effect-cli-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cli-manifest-tooling`. Evidence at HEAD ec065a7: `research/12-library-strategy.md:13`. Fix: Record the CLI-framework choice as an ADR and retire the stale @effect/cli recommendation. (effort S). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.
