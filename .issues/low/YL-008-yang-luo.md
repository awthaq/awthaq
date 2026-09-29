---
ID: "YL-008"
Title: "Correct middleware order is counterintuitive and unenforced by types"
Level: low
Category: "dx"
Status: ready-for-agent
Package: "qadi"
Source: "packages/qadi/src/AuthorizedSubject.ts:26"
Auditor: "yang-luo"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# YL-008 — Correct middleware order is counterintuitive and unenforced by types

`LOW` · `dx` · `qadi` · reported by **Yang Luo — Creator of Casbin** (`yang-luo`)

Status: **ready-for-agent**

## Summary

Enforcement correctness depends on a declaration-order inversion: to make Authentication run before AuthorizedSubject, AuthorizedSubject must be declared first (last-declared wraps outermost). The module documents that the 'natural' textual order fails at runtime with 'Service not found: CurrentPrincipal' — discovered empirically in the project's own tests — yet nothing in the type system stops a consumer from composing a group in the broken order and shipping a middleware chain that 500s (or worse, after someone 'fixes' it by swallowing the missing service).

## Evidence

Source: `packages/qadi/src/AuthorizedSubject.ts:26`

```
// with "Service not found: CurrentPrincipal", because that declaration order
// makes `AuthorizedSubject` outermost, running *before* `Authentication` has
```

## Recommended fix

Ship a composed AuthGroupExt helper (e.g. .withAuthSubjects()) that applies the pair in the proven order, and add a compile-time-brand or runtime Layer-build assertion that AuthorizedSubject never appears before its Authentication dependency in a group's middleware list.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Authorization modeling
- Full dossier: [`yang-luo`](../../.reports/yang-luo/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence medium); workstream `qadi-bridge-hardening`. Evidence at HEAD ec065a7: `packages/qadi/src/AuthorizedSubject.ts:23`. Fix: Ship a helper that applies the pair in the proven order and pin the type-level behaviour with a test. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.
