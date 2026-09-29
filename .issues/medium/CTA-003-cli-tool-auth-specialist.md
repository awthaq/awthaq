---
ID: "CTA-003"
Title: "No exit-code contract despite doctor being explicitly a CI tool"
Level: medium
Category: "dx"
Status: resolved
Package: "—"
Source: "features/features/08-tooling/26-cli.feature:108"
Auditor: "cli-tool-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CTA-003 — No exit-code contract despite doctor being explicitly a CI tool

`MEDIUM` · `dx` · `—` · reported by **CLI Tool Auth Specialist** (`cli-tool-auth-specialist`)

Status: **resolved**

## Summary

A repo-wide search for exit-code semantics across spec/, features/, and packages/cli finds nothing (the only 'nonzero' match is a passkey counter). Scenarios specify outcomes as prose ('it reports', 'it refuses') but never as process exit codes. spec/behaviors/26-cli.md:32 explicitly promotes doctor as runnable 'in CI, before deploy', yet CI can only detect failure by parsing human-oriented stdout — there is no specified distinction between success, validation findings, refused execution, and infrastructure error. This confirms the missing exit-code contract other auditors flagged.

## Evidence

Source: `features/features/08-tooling/26-cli.feature:108`

```
Given pending migrations reported by "awthaq migration status"
      When "awthaq migration apply" is run without the "--yes" flag
      Then it refuses to apply any migration
```

## Recommended fix

Add an exit-code contract to 26-cli.md and 26-cli.feature: 0 = success; distinct nonzero classes for validation findings (doctor), refused-without-confirmation (migration apply without --yes, seed admin without --force), and runtime/infrastructure errors; assert the codes in Gherkin scenarios.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 32/100), domain: CLI Authentication
- Full dossier: [`cli-tool-auth-specialist`](../../.reports/cli-tool-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ECS-002` — Bulk `import` migration has no confirmation, dry-run, or partial-failure semantics](high/ECS-002-effect-cli-specialist.md) `_(effect-cli-specialist, high)_`
- [`ECS-003` — BEH-EA-208 'never runs the application' boundary contradicts its own examples](medium/ECS-003-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cli-contract`. Evidence at HEAD ec065a7: `spec/behaviors/26-cli.md:32`. Fix: Add a normative exit-code contract to 26-cli.md (new cross-cutting section/requirement) and assert codes in 26-cli.feature; implement later via tagged errors carrying `Runtime.errorExitCode`. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** BEH-EA-225 exit-code table (0 ok, 1 defect, 2 usage, 3 doctor findings, 4 nothing to apply, 5 write failed, 6 refused without confirmation, 7 ledger drift, 8 auth required, 9 environment/capability unavailable). Implemented as Data.TaggedError classes carrying [Runtime.errorExitCode] in packages/cli/src/CliErrors.ts; bin.ts uses NodeRuntime.runMain. Proof: packages/cli/test/ExitCodes.test.ts, and the built binary (doctor exits 3, no database exits 9, an unknown command exits 2).
