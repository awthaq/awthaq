---
ID: "DTWS-002"
Title: "20 of 21 package READMEs claim 'no line of source in this package has shipped yet' while shipping real source"
Level: high
Category: "docs"
Status: ready-for-agent
Package: "roles"
Source: "packages/roles/README.md:3"
Auditor: "documentation-technical-writing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DTWS-002 — 20 of 21 package READMEs claim 'no line of source in this package has shipped yet' while shipping real source

`HIGH` · `docs` · `roles` · reported by **Documentation & Technical Writing Specialist** (`documentation-technical-writing-specialist`)

Status: **ready-for-agent**

## Summary

A banner sweep across packages/*/README.md found this identical 'planned package' banner in 20 of 21 files — including packages whose implementations are substantial and tested: packages/core (Auth.ts, Sessions.ts, ...), packages/roles (Roles.ts is a real AuthPlugin.Service overriding qadi's SubjectResolver), packages/password, packages/oauth, packages/admin, packages/api, packages/client, packages/react, and so on. Only packages/next/README.md has an updated banner. Every package README is therefore self-contradicting: the banner says intent-only, the body links to files that exist and run. For a mixed human/agent audience this is the worst kind of drift — it teaches readers to distrust the docs' own truth-telling mechanism.

## Evidence

Source: `packages/roles/README.md:3`

```
> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet.
```

## Recommended fix

Sweep the 20 stale banners using packages/next/README.md as the template: state per package what is shipped vs planned (genuinely unshipped today: api-key, cli, magic-link, two-factor, whose src/index.ts files are 'Empty placeholder' stubs). Then add a check to pnpm check that fails any README carrying the banner in a package whose src/ is non-placeholder.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Documentation & Spec Drift
- Full dossier: [`documentation-technical-writing-specialist`](../../.reports/documentation-technical-writing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`RRM-009` — Roles docs and metrics still claim the package is an empty placeholder](low/RRM-009-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/roles/README.md:3` matches the quoted banner verbatim; grepping `packages/*/README.md` for the banner text finds exactly 20 of 21 files carrying it (only `packages/next/README.md` is missing from the list), matching the claim precisely. Sweeping the 20 stale banners and adding a CI drift check is a well-scoped mechanical change. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `authz-docs-truthfulness`. Evidence at HEAD ec065a7: `packages/roles/README.md:3`. Fix: Rewrite the 16 stale banners to shipped-vs-planned status (packages/next/README.md as template), keep the banner only on the 4 placeholder packages, and add a CI drift check. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`.
