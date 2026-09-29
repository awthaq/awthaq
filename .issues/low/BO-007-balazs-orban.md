---
ID: "BO-007"
Title: "Wildcard re-export of @qadi/react leaks upstream renames into the public API"
Level: low
Category: "api"
Status: needs-triage
Package: "react"
Source: "packages/react/src/index.ts:19"
Auditor: "balazs-orban"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BO-007 — Wildcard re-export of @qadi/react leaks upstream renames into the public API

`LOW` · `api` · `react` · reported by **Balázs Orbán — Lead Maintainer, Auth.js** (`balazs-orban`)

Status: **needs-triage**

## Summary

The react package's entire public surface includes a blanket re-export of a third-party package at ^0.7.0 (pre-1.0): any rename, removal, or signature change in @qadi/react breaks @awthaq/react consumers with no choke point to adapt or deprecate. In a high-traffic SDK this is the classic versioning hazard — downstream code imports Can/useCan from @awthaq/react and the maintainer has zero control over what those names resolve to in the next minor. BEH-EA-184 mandates re-exporting verbatim, but verbatim does not require wildcard syntax.

## Evidence

Source: `packages/react/src/index.ts:19`

```
export * from "@qadi/react";
```

## Recommended fix

Replace the star export with explicit named re-exports of the qadi hooks actually part of the contract; add an API-report-style check so accidental surface changes fail CI.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: Framework adapters
- Full dossier: [`balazs-orban`](../../.reports/balazs-orban/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`DESS-006` — @awthaq/react star-re-exports the entire @qadi/react surface](low/DESS-006-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence medium); workstream `react-package-deps`. Evidence at HEAD ec065a7: `packages/react/src/index.ts:10`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/11-frontend-next-react-client.md`.
