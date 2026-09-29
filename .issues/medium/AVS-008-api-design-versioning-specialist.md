---
ID: "AVS-008"
Title: "ADR-EA-003's endpoint inventory already stale against shipped contract code"
Level: medium
Category: "docs"
Status: resolved
Package: "—"
Source: "spec/decisions/003-httpapi-as-contract.md:25"
Auditor: "api-design-versioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AVS-008 — ADR-EA-003's endpoint inventory already stale against shipped contract code

`MEDIUM` · `docs` · `—` · reported by **API Design & Versioning Specialist** (`api-design-versioning-specialist`)

Status: **resolved**

## Summary

The ADR is the versioned record of the contract design, yet its group inventory omits `revokeAll` (added in packages/api/src/Session.ts:58), the entire `account` group (packages/api/src/Account.ts:27), and the `subject` group — and its status remains "Accepted — design; implementation deferred" in spec/decisions/index.yaml while the implementation it describes has shipped. The contract surface is the thing this ADR exists to track; a reader using it to assess blast radius of a change gets a wrong answer. This is precisely the breaking-change communication channel (decisions tied to changelogs) the project's own persona requirements call for.

## Evidence

Source: `spec/decisions/003-httpapi-as-contract.md:25`

```
core owns the root groups (`session`: current, list, signOut, revoke, revokeOthers, per PRD §10)
```

## Recommended fix

Revise ADR-EA-003 (revision 1.1) to enumerate the actual shipped groups/endpoints and flip its status to implemented; add a standing rule that any PR adding/removing an endpoint or group must touch the owning ADR in the same changeset.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 63/100), domain: API surface & versioning
- Full dossier: [`api-design-versioning-specialist`](../../.reports/api-design-versioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `spec-surface-inventory-reconcile`. Evidence at HEAD ec065a7: `spec/decisions/003-httpapi-as-contract.md:25`. Fix: Revise ADR-EA-003 to 1.1 with the shipped core inventory (session incl. revokeAll; account: updateProfile, deleteUser; subject owned by @awthaq/qadi), flip status to implemented across all ADRs whose decision has shipped, and mechanize DoD gate 10 so contract inventory drift fails CI. (effort M). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** ADR-EA-003 rev 1.1 has a machine-checked core groups inventory (session including revokeAll, account with updateProfile, deleteUser and exportData, subject owned by @awthaq/qadi) and its Auth.api sentence now describes Auth.make's composition; every ADR 001-015 whose decision is visible in code is flipped to 'Accepted - implemented' (files, index.yaml, footers). Gate 10 is mechanized as check 12 (spec/scripts/check-drift.mjs diffs the inventory against packages/api/src; removing revokeAll from the ADR fails it with the source and ADR lists) and the DoD per-change checklist has the standing rule. Deviation: the walker scans the source for HttpApiGroup/HttpApiEndpoint declarations instead of importing built libs, so spec:verify needs no build.
