---
ID: "CTA-002"
Title: "BEH-EA-208 normatively bars every CLI login flow shape, with no documented carve-out"
Level: high
Category: "architecture"
Status: ready-for-agent
Package: "—"
Source: "spec/behaviors/26-cli.md:157"
Auditor: "cli-tool-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CTA-002 — BEH-EA-208 normatively bars every CLI login flow shape, with no documented carve-out

`HIGH` · `architecture` · `—` · reported by **CLI Tool Auth Specialist** (`cli-tool-auth-specialist`)

Status: **ready-for-agent**

## Summary

The CLI's defining boundary forbids any command from starting an HTTP listener or accepting a request. Both viable terminal login mechanisms violate this as written: a local-server redirect callback needs a listening socket, and an RFC 8628 device-flow poll performs live HTTP against a running auth server. The spec is internally consistent today only because it never contemplates login; the moment a login command is added it will conflict with a normative MUST NOT. This is the CLI-side half of the same boundary conflict the device-authorization audit identified against spec/models/13-device-authorization.md.

## Evidence

Source: `spec/behaviors/26-cli.md:157`

```
REQUIREMENT: Every CLI command MUST operate on `Auth.make`'s statically
             derived manifest (contract, tables, migrations, plugin graph); no
             CLI command MUST start an HTTP listener, accept a request, or
```

## Recommended fix

Amend BEH-EA-208 with an explicit carve-out (for example: except a first-party login command, which acts as a client of a running auth server) or normatively assign login to @awthaq/client with the CLI delegating to it; record the decision in both 26-cli.md and the device-authorization model doc before Phase 3.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 32/100), domain: CLI Authentication
- Full dossier: [`cli-tool-auth-specialist`](../../.reports/cli-tool-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BAM-001` — better-auth import tooling is spec-only; the cli package ships nothing](high/BAM-001-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`DAG-003` — Normative CLI boundary (BEH-EA-208) forbids exactly the network behavior a device-flow login client needs](high/DAG-003-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, high)_`
- [`ECS-001` — No exit-code contract despite CI-first design](high/ECS-001-effect-cli-specialist.md) `_(effect-cli-specialist, high)_`
- [`ECS-005` — doctor has no secret-redaction requirement for reported configuration](medium/ECS-005-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`
- [`ECS-006` — No audit trail for seed admin privilege promotion](medium/ECS-006-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`
- [`ECS-007` — CLI argument validation not tied to the repo's Schema contracts](medium/ECS-007-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `spec/behaviors/26-cli.md:156-159` (cited as :157) contains the quoted REQUIREMENT verbatim, barring any CLI command from starting a listener or accepting a request, and neither `26-cli.md` nor `spec/models/13-device-authorization.md` documents a login carve-out. Amending a normative spec requirement is a spec/architecture decision, not a mechanical code change. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [CLI login flow design vs. the BEH-EA-208 network-boundary prohibition](../../.scratch/resolve-ready-for-human-findings/issues/06-cli-login-vs-beh-ea-208.md) — amend BEH-EA-208 with an explicit session-command exception (`login`/`logout`/`whoami` may act as an outbound network client of a running server; they still may not start a listener or accept inbound requests), narrowing the requirement's scope without relaxing its protected property. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cli-session-login-carveout`. Evidence at HEAD ec065a7: `spec/behaviors/26-cli.md:156`. Fix: Apply decision ticket 06 verbatim: amend BEH-EA-208 so it scopes to *inspection* commands and carve out a `login`/`logout`/`whoami` session-command family that is an outbound-only client of a running server (never a listener, never inbound), add a new behavior for that family, and cross-link spec/models/13-device-authorization.md. (effort M). Full dossier: `.plan/slices/12-spec.md`.
