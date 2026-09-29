---
ID: "RRM-012"
Title: "Slot-conflict enforcement lands at layer build, not Auth.make as spec promises"
Level: info
Category: "architecture"
Status: ready-for-agent
Package: "qadi"
Source: "packages/qadi/src/SubjectResolver.ts:20"
Auditor: "rbac-role-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRM-012 — Slot-conflict enforcement lands at layer build, not Auth.make as spec promises

`INFO` · `architecture` · `qadi` · reported by **RBAC Role Modeling Specialist** (`rbac-role-modeling-specialist`)

Status: **ready-for-agent**

## Summary

BEH-EA-138/REQ-EA-385-387 promise that two plugins overriding SubjectResolver 'MUST fail at Auth.make' as a compile error; the code documents why that is structurally unreachable (a Context.Reference override's ROut is never, so no pairwise type walk can observe it — SubjectResolver.ts:12-24) and enforces the same conflict at Layer-build time via the SlotsRegistry. The deviation is honestly argued and still fails before any request, but the spec and the 18-roles feature file (REQ-EA-385-387) now over-promise the enforcement point, which matters to anyone modeling a second subject-resolving plugin (for example a future multi-tenant role provider).

## Evidence

Source: `packages/qadi/src/SubjectResolver.ts:20`

```
`Roles` claims this slot through `Slots.override`, which enforces the
same conflict, at `Layer`-build time, through an explicit registry
instead
```

## Recommended fix

Amend BEH-EA-138's enforcement wording to 'at composition/Layer-build time via the slot registry' and add a registry-conflict scenario to the plugin-contract tests so the guarantee is pinned where it actually lives.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: RBAC role modeling
- Full dossier: [`rbac-role-modeling-specialist`](../../.reports/rbac-role-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 34 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AAPS-006` — SessionViewExtension slot from ADR-EA-012 never declared; no channel for session trust attributes](medium/AAPS-006-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, medium)_`
- [`AAPS-009` — ApiKey/Service principals carry no attribute payload; attribute policies deny them by construction](info/AAPS-009-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, info)_`
- [`SAM-007` — Token claims are write-only: auth.jwt()-based policies have no read path into qadi](medium/SAM-007-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `authz-docs-truthfulness`. Evidence at HEAD ec065a7: `spec/behaviors/18-roles-subject-resolver.md:44`. Fix: Align BEH-EA-138/REQ-EA-385-387 with the real enforcement point and pin it with a roles-specific test. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.
