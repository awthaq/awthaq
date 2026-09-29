---
ID: "ECS-009"
Title: "migration apply ships without the plan/drift guardrails deferred to the CLI"
Level: low
Category: "dx"
Status: resolved
Package: "—"
Source: "spec/behaviors/05-persistence-stratum.md:132"
Auditor: "effect-cli-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECS-009 — migration apply ships without the plan/drift guardrails deferred to the CLI

`LOW` · `dx` · `—` · reported by **Effect CLI Specialist** (`effect-cli-specialist`)

Status: **resolved**

## Summary

BEH-EA-039 designates the CLI as the home for diff planning, checksums, drift detection, and destructive-change guardrails, yet BEH-EA-204's apply has only a `--yes` flag - no plan preview, no ledger checksum, no drift check - while ADR-004 records the stock Migrator as 'single-transaction, ids-only, no checksums, no dry-run'. The first shipped apply path therefore operates with the weakest safety set the project itself has documented.

## Evidence

Source: `spec/behaviors/05-persistence-stratum.md:132`

```
live-database drift check to function; those capabilities, when
built, MUST live in the CLI, consuming the same `auth.migrations`
value the runtime already produces.
```

## Recommended fix

Even before the full diff planner lands, require `migration apply` (or a sibling `migration plan`) to print the pending ordered set and refuse on ledger drift or unknown applied keys; `migration status` should fail loudly when the linker's re-keyed record and the driver ledger diverge.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Operator CLI tooling
- Full dossier: [`effect-cli-specialist`](../../.reports/effect-cli-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cli-migration-guardrails`. Evidence at HEAD ec065a7: `spec/behaviors/05-persistence-stratum.md:130`. Fix: Give the first shipped `migration apply` the minimum guardrails BEH-EA-039 promises the CLI owns: print the ordered pending plan, refuse on ledger drift (applied ids unknown to the linker, or out-of-order gaps), and make `status` fail loudly on divergence. (effort M). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** BEH-EA-204/039 guardrails: migration status is read-only and fails LedgerDrift (exit 7) on an applied id or name the linker does not know or a pending id sorting before an applied one; apply prints the ordered pending plan, refuses on drift, needs --yes, supports --dry-run and --allow-empty (exit 4 when nothing is pending). Both ledgers (effect_sql_migrations and awthaq_plugin_migrations) go through Migrator/Migrations.run; on Postgres the CLI client registers the client-scoped regclass codec (fails with exit 5 without it, proven on a real Postgres via packages/cli/test/Migration.postgres.test.ts, added to scripts/test-pg.sh). Proof: packages/cli/test/Migration.test.ts over SQLite.
