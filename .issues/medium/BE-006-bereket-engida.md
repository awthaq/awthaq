---
ID: "BE-006"
Title: "Core and plugin routes split across two HttpApi contracts"
Level: medium
Category: "dx"
Status: resolved
Package: "api"
Source: "packages/api/src/AuthCore.ts:6"
Auditor: "bereket-engida"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BE-006 — Core and plugin routes split across two HttpApi contracts

`MEDIUM` · `dx` · `api` · reported by **Bereket Engida — Creator of better-auth** (`bereket-engida`)

Status: **resolved**

## Summary

An application serves AuthCoreApi (session/account groups) and Auth.make's plugin-only api as two separate contracts — the README quickstart wires both by hand. Client-side that means two HttpApiClient (or AtomHttpApi) instantiations and two OpenAPI documents; a better-auth application has exactly one auth object and one client. Auth.make's composed api (packages/core/src/Auth.ts:374) already flattens every plugin's groups into one HttpApi, so the remaining work is prepending the fixed core groups.

## Evidence

Source: `packages/api/src/AuthCore.ts:6`

```
// `Auth.make`'s eventual plugin-contract merge (BEH-EA-032) will fold
// plugin groups into an api built the same way, under the same "auth"
// id — that composition is separate, later work
```

## Recommended fix

Finish BEH-EA-032: have Auth.make prepend SessionGroup/AccountGroup to the composed api so one contract, one client, and one OpenAPI doc cover a full composition; keep AuthCoreApi exported for the standalone use case.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: plugin architecture parity
- Full dossier: [`bereket-engida`](../../.reports/bereket-engida/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AVS-002` — Seven parallel standalone `HttpApi` values; core groups not yet folded into Auth.make's composed api](medium/AVS-002-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `httpapi-surface-consolidation`. Duplicate of `MW-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Auth.ts:390`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `MW-002-matias-woloski` — closed by its fix (see that issue's Resolved comment).
