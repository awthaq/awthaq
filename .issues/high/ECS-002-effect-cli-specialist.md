---
ID: "ECS-002"
Title: "Bulk `import` migration has no confirmation, dry-run, or partial-failure semantics"
Level: high
Category: "security"
Status: resolved
Package: "—"
Source: "features/features/08-tooling/26-cli.feature:187"
Auditor: "effect-cli-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECS-002 — Bulk `import` migration has no confirmation, dry-run, or partial-failure semantics

`HIGH` · `security` · `—` · reported by **Effect CLI Specialist** (`effect-cli-specialist`)

Status: **resolved**

## Summary

REQ-EA-596..599 cover source formats, unmapped-field reporting, runtime independence, and a validation caveat - but nothing governs the write side of a production user-base migration: no `--dry-run`/plan preview, no confirmation flag (unlike `migration apply --yes` and `seed admin --force`), no batch/transaction boundaries, no partial-failure or resume story, no audit record. An operator can silently half-write a production user base. This is precisely the destructive-command red flag the project polices elsewhere in the same feature file.

## Evidence

Source: `features/features/08-tooling/26-cli.feature:187`

```
When "awthaq import --from <framework>" runs
Then the export's tables are translated into awthaq's own Model.Class shapes
```

## Recommended fix

Extend BEH-EA-207: require a plan/preview mode reporting per-table row counts and unmapped fields, an explicit confirmation flag before any write, per-batch failure reporting with a resumable checkpoint, and an AuthEvents audit event per completed import.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Operator CLI tooling
- Full dossier: [`effect-cli-specialist`](../../.reports/effect-cli-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CTA-003` — No exit-code contract despite doctor being explicitly a CI tool](medium/CTA-003-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`ECS-003` — BEH-EA-208 'never runs the application' boundary contradicts its own examples](medium/ECS-003-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `features/features/08-tooling/26-cli.feature`'s BEH-EA-207 rule (REQ-EA-596..599) has no dry-run/confirmation/batch scenario, while sibling commands in the same file do (`migration apply --yes` at line 106-120, `seed admin --force` at line 171-176). The gap is real and the recommended fix follows an established in-file pattern. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cli-contract`. Evidence at HEAD ec065a7: `spec/behaviors/26-cli.md:135`. Fix: Extend BEH-EA-207 (and 26-cli.feature's @BEH-EA-207 Rule) with a write-side contract: default plan/preview mode, explicit --yes confirmation before any write, per-batch transactions with failure reporting and a resumable checkpoint (the `awthaq_import_runs` ledger already decided in wayfinder ticket 07 §6), and a typed AuthEvents audit event per completed/aborted run. Then honor it in the ticket-07 `Import.ts` implementation. (effort M). Full dossier: `.plan/slices/13-repo-features-tooling.md`.

**Resolved (2026-09-29):** BEH-EA-207 write-side contract, spec and implementation: plan mode by default (--dry-run alias), --yes writes in bounded batches each in ONE transaction, a failed batch rolls back only itself and is reported with source row ids and error tag, the run stops (or --continue-on-error continues) at the last committed checkpoint (awthaq_import_runs, written inside the same transaction), a re-run resumes without double-inserting, and each --yes run publishes auth.import.completed / auth.import.failed (added to AuthEvents + AuditLog). Code: packages/cli/src/Import.ts, packages/core AuthEvents. Proof: packages/cli/test/Import.test.ts (plan writes nothing; --yes writes and audits; forced batch failure via a SQL trigger rolls back including the ledger, reports its ids, exits 5, and resumes after repair; --continue-on-error; conflicts; --report), packages/core/test/AuditLog.test.ts. Deviation from the dossier: the checkpoint table is created by `import --yes` itself (CREATE TABLE IF NOT EXISTS) rather than a core migration, because it is CLI tooling state and core migration ids are contested across programs; recorded in BEH-EA-207.
