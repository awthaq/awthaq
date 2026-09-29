---
ID: "AAPS-007"
Title: "Spec's BEH-EA-161 illustration resolves u.plan; UserRecord has no plan field"
Level: low
Category: "docs"
Status: resolved
Package: "—"
Source: "spec/behaviors/21-qadi-resolvers-obligations.md:27"
Auditor: "abac-attribute-policy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AAPS-007 — Spec's BEH-EA-161 illustration resolves u.plan; UserRecord has no plan field

`LOW` · `docs` · `—` · reported by **ABAC Attribute-Based Policy Specialist** (`abac-attribute-policy-specialist`)

Status: **resolved**

## Summary

The behavior spec's canonical resolver resolves a `plan` attribute from the user record, but UserRecord (packages/core/src/Users.ts:28-36) carries id/email/emailVerified/name/createdAt/updatedAt — no plan. The implemented resolver resolves the three real fields and its header comment documents the deviation ("there is no `plan` field on `UserRecord`, unlike the spec's own illustrative example"). Honest, but it leaves the spec text describing an attribute no producer can ever answer — a policy author following BEH-EA-161 writes `hasAttribute plan` and gets permanent "has no value" denials.

## Evidence

Source: `spec/behaviors/21-qadi-resolvers-obligations.md:27`

```
Effect.map((u) => attribute === "plan" ? u.plan : undefined),
```

## Recommended fix

Update BEH-EA-161's illustration to the shipped attribute set (or add plan to UserRecord when a billing plugin arrives), and keep the requirement text (undefined vs AttributeResolveError) untouched since the code satisfies it.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: ABAC attributes & policy
- Full dossier: [`abac-attribute-policy-specialist`](../../.reports/abac-attribute-policy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`RZS-007` — Behavior spec claims pre-implementation while the resolver ships, hiding the spec/code divergence](low/RZS-007-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `spec-behavior-code-reconcile`. Evidence at HEAD ec065a7: `spec/behaviors/21-qadi-resolvers-obligations.md:26`. Fix: Spec follows code for the attribute set (no billing plugin exists; don't invent `plan`); code follows spec for the failure contract — UserAttributes must map a user-table defect to AttributeResolveError. Also refresh the stale 'unhandled resolver conflict' paragraph now that attributeResolverRegistry ships. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** spec/behaviors/21-qadi-resolvers-obligations.md rev 1.2: the BEH-EA-161 example is rewritten to the shipped shape (no plan attribute; findById, UserNotFound to undefined, a store outage or defect to AttributeResolveError), the 'no plan' prose and the deleted-user note follow, and the same-attribute-resolver paragraph is rewritten around attributeResolverRegistry and DuplicateAttributeResolver (the relationship half is still marked unhandled: no relationship registry exists). The code half of the dossier (a Users outage becomes AttributeResolveError) had already landed as TS-002 with packages/qadi/test/Resolvers.test.ts.
