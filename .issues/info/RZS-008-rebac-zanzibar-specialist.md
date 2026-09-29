---
ID: "RZS-008"
Title: "Zanzibar-grade consistency machinery absent by explicit delegation — the seam to fill is the resolver port"
Level: info
Category: "architecture"
Status: ready-for-agent
Package: "—"
Source: "spec/decisions/009-authorization-delegated-to-qadi.md:19"
Auditor: "rebac-zanzibar-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RZS-008 — Zanzibar-grade consistency machinery absent by explicit delegation — the seam to fill is the resolver port

`INFO` · `architecture` · `—` · reported by **ReBAC / Zanzibar-style Specialist** (`rebac-zanzibar-specialist`)

Status: **ready-for-agent**

## Summary

Measured absences, each verified: zero occurrences of zookie/revision-token/staleness-bound concepts in packages/; no tuple store (packages/sql contains no organization/team tables — the plugin owns its persistence directly, TeamRecords.ts:1-9); no reverse index or graph expansion API (@qadi/core's SubjectSet batches subjects against a policy, not edges); no permission-cache warming. ADR-EA-009 records this as deliberate: awthaq ships the bridge, engines own the graph. The honest consequence for this domain: there is no bounded-staleness read model to evaluate because there is no separate graph store to drift — the resolver reads the system of record, which is why the only consistency risk is the decision cache (RZS-002), not dual-write drift. If ReBAC-grade transitivity, sub-check latency engineering, or consistency tokens are ever required, the RelationshipResolver/AttributeResolver layer exports are the pre-built insertion point; a Zanzibar-style engine could replace OrganizationQadi.relationships without qadi or the applications knowing.

## Evidence

Source: `spec/decisions/009-authorization-delegated-to-qadi.md:19`

```
relationship-graph storage, policy DSL parsing, policy distribution, reverse-index list queries — these are what SpiceDB/OpenFGA/Cedar/OPA do
```

## Recommended fix

Keep the delegation, but document the consistency contract at the seam: state in usage-qadi-adjacent docs that relationship answers are as fresh as the records layer, that the DecisionCache (when app-scoped) weakens this (RZS-002), and that swapping in a Zanzibar-style engine means replacing exactly the OrganizationQadi.relationships layer — ideally with a worked example exporting membership tuples to OpenFGA/SpiceDB.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Relationship-based authorization
- Full dossier: [`rebac-zanzibar-specialist`](../../.reports/rebac-zanzibar-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `qadi-decision-cache-invalidation`. Evidence at HEAD ec065a7: `spec/decisions/009-authorization-delegated-to-qadi.md:19`. Fix: Document the consistency contract at the resolver seam alongside the cache fix: relationship answers are as fresh as the records layer; a request-scoped cache preserves that, an app-scoped one needs the invalidation bridge; swapping in a Zanzibar engine = replacing OrganizationQadi.relationships. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
