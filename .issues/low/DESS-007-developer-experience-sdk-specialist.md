---
ID: "DESS-007"
Title: "@awthaq/react's description claims integration with @awthaq/client that does not exist"
Level: low
Category: "docs"
Status: resolved
Package: "react"
Source: "packages/react/package.json:5"
Auditor: "developer-experience-sdk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DESS-007 — @awthaq/react's description claims integration with @awthaq/client that does not exist

`LOW` · `docs` · `react` · reported by **Developer Experience / SDK Specialist** (`developer-experience-sdk-specialist`)

Status: **resolved**

## Summary

The package describes itself as 'glue over @awthaq/client' (also packages/react/src/index.ts:3), but @awthaq/client appears in no dependency list (packages/react/package.json:33-39) and in no import — only in one history comment (AuthClientAtom.ts:10). The atoms are built directly on effect/unstable/reactivity/AtomHttpApi over @awthaq/api contracts. A consumer reading the description will go looking for the shared client object, session store, or facade integration and find none; the two packages are parallel siblings, not layers, which is a genuinely surprising architecture the docs actively mislabel.

## Evidence

Source: `packages/react/package.json:5`

```
"description": "React provider glue over @awthaq/client, including QadiProvider integration.",
```

## Recommended fix

Reword the description (and index.ts header) to 'React provider glue over the @awthaq/api contracts via effect's AtomHttpApi' — or, if the intended end-state really is layering over @awthaq/client, note that explicitly as a planned change so the current parallel structure reads as deliberate.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: consumer SDK DX
- Full dossier: [`developer-experience-sdk-specialist`](../../.reports/developer-experience-sdk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`MM-001` — Exports wildcard bun condition cannot resolve .tsx files (react Providers)](medium/MM-001-mattia-manzati.md) `_(mattia-manzati, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `frontend-docs-truthfulness`. Evidence at HEAD ec065a7: `packages/react/package.json:5`. Fix: Make the claim true (BE-004 adds @awthaq/client as a real dependency for CsrfClientLive) or reword; fix the client package's own misleading description too. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** package.json descriptions and index.ts headers reworded: react 'React bindings: reactive AtomHttpApi clients over the awthaq contract (CSRF via @awthaq/client) and Providers with QadiProvider integration' (true now that @awthaq/client is a dependency); client 'Effect HttpApiClient bindings for the awthaq contract: ...'.
