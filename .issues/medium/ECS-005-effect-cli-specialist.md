---
ID: "ECS-005"
Title: "doctor has no secret-redaction requirement for reported configuration"
Level: medium
Category: "security"
Status: resolved
Package: "—"
Source: "spec/behaviors/26-cli.md:24"
Auditor: "effect-cli-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECS-005 — doctor has no secret-redaction requirement for reported configuration

`MEDIUM` · `security` · `—` · reported by **Effect CLI Specialist** (`effect-cli-specialist`)

Status: **resolved**

## Summary

doctor is designed to run in CI where output lands in build logs. The spec elsewhere fixes secrets as `Config.Redacted` (BEH-EA-126, OAuth client secrets) and Effect v4 ships Redacted/Redactable masking, but BEH-EA-201 nowhere forbids printing secret-valued config or requires masking in the report. A doctor run echoing a database URL or OAuth client secret 'value it can validate' leaks credentials into CI logs.

## Evidence

Source: `spec/behaviors/26-cli.md:24`

```
REQUIREMENT: `awthaq doctor` MUST report every plugin-graph linking
problem, every configuration value it can validate, and every
```

## Recommended fix

Add an explicit clause: doctor reports validity verdicts and non-sensitive values only; `Config.Redacted` inputs are reported as present/valid/invalid, never as values - enforced by a BDD scenario asserting a secret never appears in output.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Operator CLI tooling
- Full dossier: [`effect-cli-specialist`](../../.reports/effect-cli-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BAM-001` — better-auth import tooling is spec-only; the cli package ships nothing](high/BAM-001-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`CTA-002` — BEH-EA-208 normatively bars every CLI login flow shape, with no documented carve-out](high/CTA-002-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, high)_`
- [`DAG-003` — Normative CLI boundary (BEH-EA-208) forbids exactly the network behavior a device-flow login client needs](high/DAG-003-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, high)_`
- [`ECS-001` — No exit-code contract despite CI-first design](high/ECS-001-effect-cli-specialist.md) `_(effect-cli-specialist, high)_`
- [`ECS-006` — No audit trail for seed admin privilege promotion](medium/ECS-006-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`
- [`ECS-007` — CLI argument validation not tied to the repo's Schema contracts](medium/ECS-007-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cli-doctor-hardening`. Evidence at HEAD ec065a7: `spec/behaviors/26-cli.md:24`. Fix: Add a CLI-wide output-redaction requirement: configuration inputs that are Config.Redacted (or declared sensitive in the ECS-008 descriptors) are reported only as present/valid/invalid, never as values, enforced by a BDD scenario and a unit test. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** BEH-EA-201 no-secret-values clause: a Redacted or declared-sensitive input is reported only as <redacted> (present/valid/invalid), in text, --json, config list and error messages; a connection string's password is scrubbed even from an undeclared field; a build failure is reported by the failure's name, never its message (a Config error can quote the value). Implemented in packages/core ConfigDescriptor (flatten/scrubCredentials) and packages/cli Doctor/Output. Proof: packages/cli/test/Doctor.test.ts ('prints neither the secrets nor the connection password, in text or JSON' with canary secrets, and 'reports an application Layer that fails to build without quoting the failure'), packages/core/test/EffectiveConfig.test.ts.
