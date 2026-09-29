---
ID: "BAM-001"
Title: "better-auth import tooling is spec-only; the cli package ships nothing"
Level: high
Category: "dx"
Status: resolved
Package: "—"
Source: "spec/behaviors/26-cli.md:131"
Auditor: "better-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BAM-001 — better-auth import tooling is spec-only; the cli package ships nothing

`HIGH` · `dx` · `—` · reported by **better-auth Migration Specialist** (`better-auth-migration-specialist`)

Status: **resolved**

## Summary

BEH-EA-207 requires an import command translating better-auth/authjs/lucia tables into awthaq's Model.Class shapes, and the spec text itself concedes no source-framework mapping has been built or tested against a real export. The cli package (packages/cli/src/index.ts:10) is an `export {}` placeholder. This is the single largest blocker for the migration story this persona exists to execute: today every team hand-writes their own ETL.

## Evidence

Source: `spec/behaviors/26-cli.md:131`

```
awthaq import --from better-auth|authjs|lucia
```

## Recommended fix

Ship BEH-EA-207 incrementally: start with a tested better-auth fixture (user/account/session/verification rows), implement the table mapping as pure functions over the existing Model.Classes, and surface it through the planned migration status/apply ledger so partial imports are resumable.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: better-auth parity
- Full dossier: [`better-auth-migration-specialist`](../../.reports/better-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 46 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CTA-002` — BEH-EA-208 normatively bars every CLI login flow shape, with no documented carve-out](high/CTA-002-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, high)_`
- [`DAG-003` — Normative CLI boundary (BEH-EA-208) forbids exactly the network behavior a device-flow login client needs](high/DAG-003-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, high)_`
- [`ECS-001` — No exit-code contract despite CI-first design](high/ECS-001-effect-cli-specialist.md) `_(effect-cli-specialist, high)_`
- [`ECS-005` — doctor has no secret-redaction requirement for reported configuration](medium/ECS-005-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`
- [`ECS-006` — No audit trail for seed admin privilege promotion](medium/ECS-006-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`
- [`ECS-007` — CLI argument validation not tied to the repo's Schema contracts](medium/ECS-007-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [CLI schema/migration tooling & better-auth import tooling scope](../../.scratch/resolve-ready-for-human-findings/issues/07-cli-schema-migration-tooling.md) — a generic `SourceAdapter` interface and `import --from <source>` command surface, mapping source rows onto existing `Model.Class` shapes through the same domain services (`Users`, `Accounts`) as `seed admin`, with only the `better-auth` adapter implemented and validated first (`authjs`/`lucia` registered but unimplemented) — flagged as a scope call worth confirming. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `spec/behaviors/26-cli.md:131` matches (the `awthaq import --from better-auth|authjs|lucia` example), and `packages/cli/src/index.ts` is still an `export {}` placeholder. Building the import ETL (source-framework table mapping, resumable apply ledger) requires real design work beyond mechanical wiring. Status → ready-for-human.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cli-import-tooling`. Evidence at HEAD ec065a7: `spec/behaviors/26-cli.md:131`. Fix: Follow decision ticket 07 §6: a generic `SourceAdapter` interface and `import --from <source>` command, only the better-auth adapter implemented and validated against a real export fixture; authjs/lucia registered but refusing with a typed NotImplemented error; rows go through Users/Accounts domain services; unmapped fields reported; resumable via an import-runs table. (effort XL). Full dossier: `.plan/slices/12-spec.md`.

**Resolved (2026-09-29):** awthaq import --from better-auth via the generic SourceAdapter registry (packages/cli/src/Sources.ts, Import.ts): read (keyset-paginated), map onto UserImport.ImportUserInput through Schemas, unmapped columns reported, credentials stored verbatim for BetterAuthScryptVerifier, resumable via awthaq_import_runs; authjs and lucia are registered and refused with NotYetValidated (exit 2). The better-auth adapter (packages/migrate-better-auth/src/BetterAuthSource.ts) is validated against a REAL export: test/fixtures/better-auth-export.sqlite was produced by better-auth 1.7.6 itself (its migrations, signUpEmail, internal adapter createOAuthUser; generator script beside it). Proof: migrate-better-auth/test/BetterAuthSource.test.ts (imported password verifies with the real password and is flagged for rehash), cli/test/Import.test.ts. Note: the rows are written through P14's UserImport.importUser.
