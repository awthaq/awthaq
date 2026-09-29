---
ID: "PERS-009"
Title: "qadi package README still claims nothing has shipped"
Level: low
Category: "docs"
Status: resolved
Package: "qadi"
Source: "packages/qadi/README.md:3"
Auditor: "policy-engine-rego-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PERS-009 — qadi package README still claims nothing has shipped

`LOW` · `docs` · `qadi` · reported by **Policy Engine / Rego Specialist** (`policy-engine-rego-specialist`)

Status: **resolved**

## Summary

The package ships 512 LOC across six implemented modules (bridge middleware, resolvers, obligation handlers) whose headers document real, tested behavior — the README's blanket pre-implementation disclaimer is stale. For the authorization boundary specifically, a consumer evaluating where to plug a policy engine relies on package docs to know what is real; a doc claiming the bridge is vapor leads to either duplicated extension code or wrong integration assumptions. The contract's docs-vs-code cross-check flagged exactly this divergence.

## Evidence

Source: `packages/qadi/README.md:3`

```
> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet.
```

## Recommended fix

Update the README to describe the implemented surface (AuthorizedSubject, SubjectExtractor, SubjectResolver slot, Resolvers) and keep the pre-implementation banner only on genuinely placeholder packages.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Policy Extension Points
- Full dossier: [`policy-engine-rego-specialist`](../../.reports/policy-engine-rego-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 28 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `authz-docs-truthfulness`. Duplicate of `DTWS-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/qadi/README.md:3`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `DTWS-002-documentation-technical-writing-specialist` — closed by its fix (see that issue's Resolved comment).
