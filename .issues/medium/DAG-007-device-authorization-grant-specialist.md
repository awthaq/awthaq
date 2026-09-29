---
ID: "DAG-007"
Title: "Zero test or BDD coverage allocated to the device domain"
Level: medium
Category: "testing"
Status: resolved
Package: "—"
Source: "spec/models/13-device-authorization.md:63"
Auditor: "device-authorization-grant-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DAG-007 — Zero test or BDD coverage allocated to the device domain

`MEDIUM` · `testing` · `—` · reported by **Device Authorization Grant Specialist** (`device-authorization-grant-specialist`)

Status: **resolved**

## Summary

The Gherkin suite allocates REQ-EA-001 through REQ-EA-602 across features/ with no device-authorization scenarios, and traceability maps no requirement to MOD-EA-013. The device flow is precisely where unpinned race semantics bite (concurrent /device/token polls, claim-vs-claim on the verification page, poll racing approval), so the absence of executable specification makes silent regressions likely when Phase 3 lands.

## Evidence

Source: `spec/models/13-device-authorization.md:63`

```
None yet — no test exists.
```

## Recommended fix

At Phase-3 kickoff, add feature scenarios before code: authorization_pending → approved and denied polling paths, slow_down backoff, expired_token with row cleanup, double-redemption race (one winner), verification-page claim idempotency for the same session and impossibility for a different session, and unclaimed-code denial of approve.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 34/100), domain: Device Authorization Grant
- Full dossier: [`device-authorization-grant-specialist`](../../.reports/device-authorization-grant-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`DAG-004` — No user-code entropy/format or rate-limit design exists for the verification surface](medium/DAG-004-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, medium)_`
- [`DAG-006` — Session-issuance integration point is well-prepared for a future device flow](info/DAG-006-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `device-authorization-design`. Evidence at HEAD ec065a7: `spec/models/13-device-authorization.md:63`. Fix: Author the device-authorization feature file (scenarios before code) and its traceability, registered as @skip @unwired until the plugin exists. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Authored features/features/05-authentication-methods/28-device-authorization.feature (13 scenarios, @skip @unwired: pending->approved once, denied cleanup, slow_down, rejected polls still count, expired cleanup, two concurrent polls exactly one session + invalid_grant, session only after the atomic claim, claim idempotent for same session / impossible for another, approve without claim refused, unrelated caller sees only code+status, user-code rate limits (DAG-004 numbers), normalization + hashed storage, session carries device ip/UA) plus 28-device-authorization.steps.test.ts placeholder (zero steps, mirrors 26-cli), REQ-EA-634..646. Because the plugin has no BEH range, Rules are tagged @MOD-EA-013 and features/scripts/allocate-req-ea.py gained @MOD-EA support (SOURCE_MODEL, ORDER entry) so the manifest links to the model; features/traceability.md regenerated (+ oxfmt-formatted, diff limited to new rows), spec/traceability.md §6 rows/totals, features/README note, model 13 'Verification' points at the feature. pnpm run test:bdd lists the scenarios as skipped (717 total: 114 passed, 603 skipped); spec:verify:strict passes.
