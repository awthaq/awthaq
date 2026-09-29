---
ID: "ECS-007"
Title: "CLI argument validation not tied to the repo's Schema contracts"
Level: medium
Category: "api"
Status: resolved
Package: "—"
Source: "spec/behaviors/26-cli.md:131"
Auditor: "effect-cli-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECS-007 — CLI argument validation not tied to the repo's Schema contracts

`MEDIUM` · `api` · `—` · reported by **Effect CLI Specialist** (`effect-cli-specialist`)

Status: **resolved**

## Summary

The project's defining rule is Schema everywhere (BEH-EA-027 contract errors as Schema.TaggedError; Model.Class shapes), yet no CLI behavior requires options or arguments to validate through the same Schemas the HTTP endpoints use. `seed admin`'s account identifier has no declared Schema (the BDD example 'ops@acme.com' implies email format but specifies none), `import --from`'s enumeration exists only as prose, and BEH-EA-208's manifest defines no argument-schema surface. A second, ad hoc parser is exactly the drift the shared-service-layer discipline exists to prevent.

## Evidence

Source: `spec/behaviors/26-cli.md:131`

```
awthaq import --from better-auth|authjs|lucia
```

## Recommended fix

State in file 26 that every CLI option/argument is a Schema-validated value - reuse the API's email/user Schema for seed admin and a Schema enum for `--from` - so invalid input fails as a typed error rendered uniformly (and exit-coded, per ECS-001).

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
- [`ECS-006` — No audit trail for seed admin privilege promotion](medium/ECS-006-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cli-exit-code-and-arg-contract`. Evidence at HEAD ec065a7: `spec/behaviors/26-cli.md:131`. Fix: Make 'every CLI option/argument decodes through a Schema, reusing the HTTP contract's Schemas where one exists' normative, so invalid input fails as a typed usage error (exit 2). (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** BEH-EA-226: every CLI flag/argument decodes through a Schema (seed admin --email reuses EmailContract.Email; --from is Flag.Literals over the SourceAdapter registry names; --database-url, --base-url, --batch-size, --format have their own Schemas); decode failures are the usage class (exit 2) before any service is built. Tests: packages/cli/test/ExitCodes.test.ts ('seed admin --email not-an-email is a usage error before any service is built', malformed --database-url / --format) and Import.test.ts (unknown --from). No hand-rolled string parsing in packages/cli.
