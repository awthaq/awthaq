---
ID: "AAPS-006"
Title: "SessionViewExtension slot from ADR-EA-012 never declared; no channel for session trust attributes"
Level: medium
Category: "architecture"
Status: resolved
Package: "qadi"
Source: "packages/qadi/src/SubjectResolver.ts:5"
Auditor: "abac-attribute-policy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AAPS-006 — SessionViewExtension slot from ADR-EA-012 never declared; no channel for session trust attributes

`MEDIUM` · `architecture` · `qadi` · reported by **ABAC Attribute-Based Policy Specialist** (`abac-attribute-policy-specialist`)

Status: **resolved**

## Summary

ADR-EA-012 names two core slots; only SubjectResolver exists (grep for Slots.define across packages: one production hit). SessionView carries no trust/amr/authenticatedAt field a step-up attribute could ride on, and the natural producer — two-factor, which the persona names as where "is this session MFA-verified" should be computed once — is an empty `export {}` placeholder (packages/two-factor/src/index.ts:8-10). When MFA lands, without a designed channel the MFA-verified fact will either be re-derived per policy check (the exact drift this architecture exists to prevent) or squeezed through the untyped attributes bag with no single computation point. The deferral is honestly documented, but the attribute-side design is not yet reserved anywhere.

## Evidence

Source: `packages/qadi/src/SubjectResolver.ts:5`

```
// "core slots include `SubjectResolver` and `SessionViewExtension`" — a slot
// is a `Context.Reference` with a fail-closed default that a plugin may
```

## Recommended fix

Declare the SessionViewExtension slot now (even with a pass-through default) so the two-factor plugin has a defined, conflict-checked place to attach an mfaVerified attribute exactly once, flowing from session verification into every downstream subject resolution.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: ABAC attributes & policy
- Full dossier: [`abac-attribute-policy-specialist`](../../.reports/abac-attribute-policy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AAPS-009` — ApiKey/Service principals carry no attribute payload; attribute policies deny them by construction](info/AAPS-009-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, info)_`
- [`RRM-012` — Slot-conflict enforcement lands at layer build, not Auth.make as spec promises](info/RRM-012-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, info)_`
- [`SAM-007` — Token claims are write-only: auth.jwt()-based policies have no read path into qadi](medium/SAM-007-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `session-assurance-channel`. Evidence at HEAD ec065a7: `packages/qadi/src/SubjectResolver.ts:88`. Fix: Declare the ADR-EA-012 SessionViewExtension slot and carry session-trust facts (authenticatedAt, amr, derived aal) onto the principal and into AuthSubject.attributes through one mapping point. (effort L). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Session-trust facts now travel on one path: UserPrincipal.authenticatedAt and amr, derived assurance (packages/core/src/Assurance.ts: aal1/aal2/aal3, restricted sms) and SubjectResolver.principalAttributes into AuthSubject.attributes (used by @awthaq/roles). Decision (2026-09-29): the ADR-EA-012 SessionViewExtension slot is deferred (Plan note) - nothing in this program needs a session-view field the principal mapping does not already carry; revisit if a client needs assurance on the session DTO. BEH-EA-258. Tests: Assurance.test.ts, qadi/roles tests.
