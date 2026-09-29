---
ID: "ECS-001"
Title: "No exit-code contract despite CI-first design"
Level: high
Category: "dx"
Status: resolved
Package: "—"
Source: "spec/behaviors/26-cli.md:32"
Auditor: "effect-cli-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECS-001 — No exit-code contract despite CI-first design

`HIGH` · `dx` · `—` · reported by **Effect CLI Specialist** (`effect-cli-specialist`)

Status: **resolved**

## Summary

doctor is explicitly a CI/pre-deploy gate and migration status feeds deploy automation, yet BEH-EA-201..208 and all 30 BDD scenarios define zero exit codes. There is also no mapping from the repo's typed error convention (Schema.TaggedError with httpApiStatus, BEH-EA-027) to process exit status, so scripts will end up parsing prose output to decide success. This is the cheapest contract to fix before implementation and the most expensive to retrofit once CI jobs depend on current behavior.

## Evidence

Source: `spec/behaviors/26-cli.md:32`

```
`usage-examples-v4.md` §23 lists exactly this scope. Running against the statically derived manifest (BEH-EA-208) rather than a live process means `doctor` can be run in CI, before deploy, and catch a `sameSite: "lax"` or a `Mailer.layerMemory` left in production configuration before either one reaches a real user.
```

## Recommended fix

Add a BEH defining a process contract: 0 = clean/success; distinct non-zero classes for 'doctor found problems', 'nothing to apply' vs 'apply failed', 'refused without confirmation', and 'usage error' - each derived mechanically from a TaggedError `_tag` so typed domain errors render as stable exit codes. Add one scenario per class to 26-cli.feature.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Operator CLI tooling
- Full dossier: [`effect-cli-specialist`](../../.reports/effect-cli-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BAM-001` — better-auth import tooling is spec-only; the cli package ships nothing](high/BAM-001-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`CTA-002` — BEH-EA-208 normatively bars every CLI login flow shape, with no documented carve-out](high/CTA-002-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, high)_`
- [`DAG-003` — Normative CLI boundary (BEH-EA-208) forbids exactly the network behavior a device-flow login client needs](high/DAG-003-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, high)_`
- [`ECS-005` — doctor has no secret-redaction requirement for reported configuration](medium/ECS-005-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`
- [`ECS-006` — No audit trail for seed admin privilege promotion](medium/ECS-006-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`
- [`ECS-007` — CLI argument validation not tied to the repo's Schema contracts](medium/ECS-007-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — evidence quote matches `spec/behaviors/26-cli.md:32` exactly; the file confirms (line 15) the CLI is pre-implementation spec, and `grep -n "exit code"` across `spec/behaviors/26-cli.md` and `features/features/08-tooling/26-cli.feature` returns nothing. The recommended exit-code taxonomy is concrete and mechanical to add as spec/BDD content. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cli-exit-code-and-arg-contract`. Evidence at HEAD ec065a7: `spec/behaviors/26-cli.md:32`. Fix: Add a normative process contract for every CLI command: a fixed exit-code table derived mechanically from each command's TaggedError `_tag` via Effect v4's `Runtime.errorExitCode`, plus one scenario per class. (effort M). Full dossier: `.plan/slices/12-spec.md`.

**Resolved (2026-09-29):** BEH-EA-225 (see CTA-003): one normative exit-code table referenced by BEH-EA-201/204/206/207/227; every CLI error class carries its code as [Runtime.errorExitCode]; --json prints the same _tag and code on stderr (stdout stays the result); the framework's own CliError is remapped to the usage class. No command sets the process status by hand. Test: packages/cli/test/ExitCodes.test.ts.
