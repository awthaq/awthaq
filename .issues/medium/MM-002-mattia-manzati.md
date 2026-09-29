---
ID: "MM-002"
Title: "Hand-curated per-package tsconfig paths; ports carries a stale copy of client's (false api dependency edge)"
Level: medium
Category: "dx"
Status: ready-for-agent
Package: "ports"
Source: "packages/ports/tsconfig.src.json:12"
Auditor: "mattia-manzati"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MM-002 — Hand-curated per-package tsconfig paths; ports carries a stale copy of client's (false api dependency edge)

`MEDIUM` · `dx` · `ports` · reported by **Mattia Manzati — Effect Developer Tooling** (`mattia-manzati`)

Status: **ready-for-agent**

## Summary

Every one of the 21 packages overrides the base `paths` map wholesale with a hand-maintained subset of sibling aliases. Because TS child `paths` replace (not merge with) the inherited map, each new import edge must be manually added to exactly one package's tsconfig — a missing entry silently re-routes resolution through the package exports to built `lib/*.d.ts`, and a stale entry documents an edge that does not exist. ports/tsconfig.src.json is byte-identical to client's (same content hash): ports/src contains zero `@awthaq/*` imports and ports/package.json declares no @awthaq dependencies, yet its paths maps `@awthaq/api` and its references build api first. Today it is inert; tomorrow an accidental `@awthaq/api` import in ports would typecheck cleanly while failing at runtime under pnpm's strict linking — the classic phantom-dependency hole. Same stale pattern in sql (maps @awthaq/api, never imports it).

## Evidence

Source: `packages/ports/tsconfig.src.json:12`

```
"@awthaq/api": ["../api/src/index.ts"]
```

## Recommended fix

Generate each package's tsconfig paths/references from its package.json dependencies (single source of truth), or at minimum add a drift check to the circular.mjs/knip step; delete the stale ports→api (and sql→api) entries now.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 80/100), domain: dev tooling
- Full dossier: [`mattia-manzati`](../../.reports/mattia-manzati/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 33 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `tsconfig-paths-drift`. Evidence at HEAD ec065a7: `packages/ports/tsconfig.src.json:10`. Fix: Remove the stale edges and add a tsconfig-vs-package.json drift check to `pnpm check`. (effort S). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.
