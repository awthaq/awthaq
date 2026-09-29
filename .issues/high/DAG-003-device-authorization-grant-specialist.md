---
ID: "DAG-003"
Title: "Normative CLI boundary (BEH-EA-208) forbids exactly the network behavior a device-flow login client needs"
Level: high
Category: "architecture"
Status: resolved
Package: "—"
Source: "spec/behaviors/26-cli.md:156"
Auditor: "device-authorization-grant-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DAG-003 — Normative CLI boundary (BEH-EA-208) forbids exactly the network behavior a device-flow login client needs

`HIGH` · `architecture` · `—` · reported by **Device Authorization Grant Specialist** (`device-authorization-grant-specialist`)

Status: **resolved**

## Summary

BEH-EA-208 requires every CLI command to operate on the statically derived manifest and bars any CLI command from accepting a request. A device-flow login command inherently violates this: it performs live HTTP (POST /device/code, then the /device/token poll) against a running server. The spec and the package plan are internally consistent today only because neither contemplates login; the moment device authorization lands, the boundary must be reconciled or the first login command ships as an undocumented violation of a normative requirement.

## Evidence

Source: `spec/behaviors/26-cli.md:156`

```
REQUIREMENT: Every CLI command MUST operate on `Auth.make`'s statically
             derived manifest (contract, tables, migrations, plugin graph); no
             CLI command MUST start an HTTP listener, accept a request, or
```

## Recommended fix

Amend BEH-EA-208 with an explicit carve-out (e.g. 'except a first-party login command, which is a client of a running auth server') or scope the polling client to @awthaq/client with the CLI delegating to it; document whichever is chosen in both 26-cli.md and 13-device-authorization.md.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 34/100), domain: Device Authorization Grant
- Full dossier: [`device-authorization-grant-specialist`](../../.reports/device-authorization-grant-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BAM-001` — better-auth import tooling is spec-only; the cli package ships nothing](high/BAM-001-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`CTA-002` — BEH-EA-208 normatively bars every CLI login flow shape, with no documented carve-out](high/CTA-002-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, high)_`
- [`ECS-001` — No exit-code contract despite CI-first design](high/ECS-001-effect-cli-specialist.md) `_(effect-cli-specialist, high)_`
- [`ECS-005` — doctor has no secret-redaction requirement for reported configuration](medium/ECS-005-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`
- [`ECS-006` — No audit trail for seed admin privilege promotion](medium/ECS-006-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`
- [`ECS-007` — CLI argument validation not tied to the repo's Schema contracts](medium/ECS-007-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `spec/behaviors/26-cli.md:156` (cited as :156, matches exactly) is the same normative REQUIREMENT block as CTA-002; a device-flow login command's `/device/code`/`/device/token` HTTP polling directly conflicts with it, and no carve-out exists in either `26-cli.md` or `spec/models/13-device-authorization.md`. Reconciling a normative spec boundary is an architecture decision. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [CLI login flow design vs. the BEH-EA-208 network-boundary prohibition](../../.scratch/resolve-ready-for-human-findings/issues/06-cli-login-vs-beh-ea-208.md) — amend BEH-EA-208 to carve out `login`/`logout`/`whoami` as outbound-only network clients of a running server (never listeners, never inbound), and flag `spec/models/13-device-authorization.md` for a follow-up note pointing its poll's session issuance at Ticket 3's `BeforeSessionIssue` hook-point resolution. Status → ready-for-agent.

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `cli-session-login-carveout`. Duplicate of `CTA-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `spec/behaviors/26-cli.md:156`. Full dossier: `.plan/slices/12-spec.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `CTA-002-cli-tool-auth-specialist` — closed by its fix (see that issue's Resolved comment).

**Resolved (2026-09-29):** The carve-out is implemented, not just written: login is an outbound client (BEH-EA-227/307), the feature scenario 'login polls the device endpoint as an outbound client and never opens a listener' (REQ-EA-670) is wired over a real server and asserts no listener starts.
