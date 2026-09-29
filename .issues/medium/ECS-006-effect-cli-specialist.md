---
ID: "ECS-006"
Title: "No audit trail for seed admin privilege promotion"
Level: medium
Category: "compliance"
Status: resolved
Package: "—"
Source: "spec/behaviors/26-cli.md:120"
Auditor: "effect-cli-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECS-006 — No audit trail for seed admin privilege promotion

`MEDIUM` · `compliance` · `—` · reported by **Effect CLI Specialist** (`effect-cli-specialist`)

Status: **resolved**

## Summary

`seed admin --force` creates or promotes an administrative account - one of the most security-relevant events the system can produce - and the spec already has the substrate for recording it: the bounded AuthEvents pubsub (file 13) with the `auth.token.replay` precedent. BEH-EA-206 requires nothing of the sort, so an out-of-band admin grant via CLI leaves no typed event, and the persona's core probe question ('no audit trail') is answered with silence.

## Evidence

Source: `spec/behaviors/26-cli.md:120`

```
against a target that already has an administrative account
unless explicitly forced.
```

## Recommended fix

Require seed admin to publish a typed event (e.g. `auth.admin.seeded`) on AuthEvents carrying the target account id, whether it created or promoted, and the forced flag; add a refusal-path event too.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Operator CLI tooling
- Full dossier: [`effect-cli-specialist`](../../.reports/effect-cli-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BAM-001` — better-auth import tooling is spec-only; the cli package ships nothing](high/BAM-001-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`CTA-002` — BEH-EA-208 normatively bars every CLI login flow shape, with no documented carve-out](high/CTA-002-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, high)_`
- [`DAG-003` — Normative CLI boundary (BEH-EA-208) forbids exactly the network behavior a device-flow login client needs](high/DAG-003-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, high)_`
- [`ECS-001` — No exit-code contract despite CI-first design](high/ECS-001-effect-cli-specialist.md) `_(effect-cli-specialist, high)_`
- [`ECS-005` — doctor has no secret-redaction requirement for reported configuration](medium/ECS-005-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`
- [`ECS-007` — CLI argument validation not tied to the repo's Schema contracts](medium/ECS-007-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cli-seed-admin-audit`. Evidence at HEAD ec065a7: `spec/behaviors/26-cli.md:116`. Fix: Require `seed admin` to publish a typed `auth.admin.seeded` event (and a refusal event) through AuthEvents, which AuditLog persists inline. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** auth.admin.seeded (target user id, created|promoted, forced, role, via: cli) and auth.admin.seedRefused (reason: adminExists, no address) added to AuthEvents/AuditLog (actorOf exhaustive switch); BEH-EA-206 and BEH-EA-101's registry note name them; seed admin publishes one on every grant or refusal. Roles gained holders(role) for the existing-administrator check. Proof: packages/core/test/AuditLog.test.ts, packages/cli/test/Seed.test.ts (real SQLite: seeded audited with forced=true under --force, seedRefused audited on refusal), packages/roles tests (memory + SQL).
