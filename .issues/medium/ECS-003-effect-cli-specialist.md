---
ID: "ECS-003"
Title: "BEH-EA-208 'never runs the application' boundary contradicts its own examples"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "—"
Source: "features/features/08-tooling/26-cli.feature:254"
Auditor: "effect-cli-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECS-003 — BEH-EA-208 'never runs the application' boundary contradicts its own examples

`MEDIUM` · `correctness` · `—` · reported by **Effect CLI Specialist** (`effect-cli-specialist`)

Status: **ready-for-agent**

## Summary

REQ-EA-601 lists `awthaq seed admin` and `awthaq migration apply --yes` among commands that must not 'run the application it inspects', while BEH-EA-206 mandates seed admin create accounts 'through the same domain services an application would use at runtime (Users, Roles)' - which requires live Layers and a database. REQ-EA-602's 'no database connection needs to be live' is stated without scoping and is false for seed admin, import, and migration apply. The README summary ('reads the plugin manifest, never runs the application') compounds the overbreadth; an implementer honoring it could justifiably refuse DB access to seed admin.

## Evidence

Source: `features/features/08-tooling/26-cli.feature:254`

```
And no HTTP listener needs to be started and no database connection needs to be live for a CLI command to answer correctly
```

## Recommended fix

Narrow the invariant to what is true - no HTTP listener, no request served - and partition commands into 'manifest-only' (doctor, plugin list, routes, openapi, migration status) and 'database-backed' (migration apply, seed admin, import) classes, each with its own Layer requirements stated in the spec.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Operator CLI tooling
- Full dossier: [`effect-cli-specialist`](../../.reports/effect-cli-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CTA-003` — No exit-code contract despite doctor being explicitly a CI tool](medium/CTA-003-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`ECS-002` — Bulk `import` migration has no confirmation, dry-run, or partial-failure semantics](high/ECS-002-effect-cli-specialist.md) `_(effect-cli-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cli-contract`. Evidence at HEAD ec065a7: `spec/behaviors/26-cli.md:156`. Fix: Rewrite BEH-EA-208 to state the true invariant (no HTTP listener, no inbound request, no application serving) and partition commands into three classes with explicit Layer requirements: manifest-only, database-backed, and (per ticket 06) session/outbound-client. Apply together with ticket 06's pending 1.3 amendment so the REQUIREMENT is edited once. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
