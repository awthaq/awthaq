---
ID: "RZS-007"
Title: "Behavior spec claims pre-implementation while the resolver ships, hiding the spec/code divergence"
Level: low
Category: "docs"
Status: resolved
Package: "—"
Source: "spec/behaviors/21-qadi-resolvers-obligations.md:15"
Auditor: "rebac-zanzibar-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RZS-007 — Behavior spec claims pre-implementation while the resolver ships, hiding the spec/code divergence

`LOW` · `docs` · `—` · reported by **ReBAC / Zanzibar-style Specialist** (`rebac-zanzibar-specialist`)

Status: **resolved**

## Summary

OrganizationQadi.ts implements BEH-EA-162's direct-check and typed-failure clauses (defects map to RelationshipResolveError at lines 114-118, satisfying the spec's second MUST), so the doc-control banner is stale. Worse, the combination is misleading in both directions: a reader trusting the banner concludes the resolver does not exist, while a reader trusting the requirement text concludes the depth-2 walk does exist — it does not (RZS-001). This codebase's otherwise-strict convention of recording every deferral where the code lives is not honored at exactly the seam this audit targets.

## Evidence

Source: `spec/behaviors/21-qadi-resolvers-obligations.md:15`

```
> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.
```

## Recommended fix

Update the doc-control header to reflect shipped state, add a deviation note in OrganizationQadi.ts's header (matching the precedent set by the AttributeResolver-shape correction already documented there), and annotate REQ-EA-454's status in features/traceability.md.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Relationship-based authorization
- Full dossier: [`rebac-zanzibar-specialist`](../../.reports/rebac-zanzibar-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AAPS-007` — Spec's BEH-EA-161 illustration resolves u.plan; UserRecord has no plan field](low/AAPS-007-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `spec-behavior-code-reconcile`. Evidence at HEAD ec065a7: `spec/behaviors/21-qadi-resolvers-obligations.md:15`. Fix: Only the banner needs fixing; the code deviation note already exists and the REQUIREMENT stays (ticket 13 makes the code meet it). Sequence after RZS-001 so the banner can truthfully say BEH-EA-161/162/163/165 are implemented. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** spec/behaviors/21-qadi-resolvers-obligations.md banner replaced with per-behavior pointers (161 Resolvers.UserAttributes, 162 OrganizationQadi.relationships with ResourceOrganizationLookup, 163 relationshipResolverFromEdges, 165 Resolvers.reauth/ObligationHandlers.reauth, 164 an application composition over AuditLog). RZS-001 had landed, so BEH-EA-162 already documents the shipped walk; requirement texts unchanged.
