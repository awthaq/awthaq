---
ID: "DESS-006"
Title: "@awthaq/react star-re-exports the entire @qadi/react surface"
Level: low
Category: "api"
Status: ready-for-agent
Package: "react"
Source: "packages/react/src/index.ts:19"
Auditor: "developer-experience-sdk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DESS-006 — @awthaq/react star-re-exports the entire @qadi/react surface

`LOW` · `api` · `react` · reported by **Developer Experience / SDK Specialist** (`developer-experience-sdk-specialist`)

Status: **ready-for-agent**

## Summary

Every qadi hook (useCan, useSubject, useDecision, ...) is re-exported through @awthaq/react's root, so consumers cannot distinguish awthaq-owned surface from pass-through qadi surface, editor tooling attributes qadi symbols to @awthaq/react, and if an application pins a different @qadi/react version than @awthaq/react's ^0.7.0 (packages/react/package.json:37) two React contexts/registries can coexist with no type error. The header comment cites BEH-EA-184's deliberate no-wrapper rule, so this is a documented trade-off — but discoverability and dual-instance risk remain real costs.

## Evidence

Source: `packages/react/src/index.ts:19`

```
export * from "@qadi/react";
```

## Recommended fix

Keep the no-wrapper rule but make provenance explicit: either enumerate the re-exported symbols (export { useCan, useSubject, ... } from '@qadi/react') so upgrades are auditable, or add a provenance table to the package README listing exactly which exports belong to qadi.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: consumer SDK DX
- Full dossier: [`developer-experience-sdk-specialist`](../../.reports/developer-experience-sdk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-007` — Wildcard re-export of @qadi/react leaks upstream renames into the public API](low/BO-007-balazs-orban.md) `_(balazs-orban, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence medium); workstream `react-package-deps`. Evidence at HEAD ec065a7: `packages/react/src/index.ts:19`. Fix: Make the context-owning libraries peers and document provenance. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.
