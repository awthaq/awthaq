---
ID: "TIR-005"
Title: "BDD step asserting the reset transaction is an empty stub"
Level: medium
Category: "testing"
Status: resolved
Package: "—"
Source: "features/step-definitions/PasswordSteps.ts:377"
Auditor: "token-introspection-revocation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TIR-005 — BDD step asserting the reset transaction is an empty stub

`MEDIUM` · `testing` · `—` · reported by **Token Introspection & Revocation Specialist** (`token-introspection-revocation-specialist`)

Status: **resolved**

## Summary

REQ-EA-317's acceptance scenario ends with 'And all three effects commit under one transaction', but the step definition is yield* Effect.void - it asserts nothing, so the suite reports REQ-EA-317 as covered while TIR-004's non-transactional implementation sails through green. A revocation guarantee whose only test is a no-op is worse than no test: it manufactures false confidence in exactly the invariant (atomic revocation propagation) this domain depends on.

## Evidence

Source: `features/step-definitions/PasswordSteps.ts:377`

```
Then("all three effects commit under one transaction", function* () {
  yield* Effect.void;
});
```

## Recommended fix

Implement the step for real - e.g. inject a failing SqlClient after updateCredentialHash and assert the reset token is un-consumed and sessions survive - or mark the scenario @skip like the concurrent-revoke one, so the traceability matrix stops counting phantom coverage.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Token revocation & introspection
- Full dossier: [`token-introspection-revocation-specialist`](../../.reports/token-introspection-revocation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-004` — Given/When inversion: Given performs the action while When is a stub](medium/AH-004-aslak-hellesoy.md) `_(aslak-hellesoy, medium)_`
- [`AH-007` — Catch-all Given("{string}") step dispatches on substring content](medium/AH-007-aslak-hellesoy.md) `_(aslak-hellesoy, medium)_`
- [`AH-008` — Scenario text documents fiction: named sessions and emails are silently replaced in wiring](low/AH-008-aslak-hellesoy.md) `_(aslak-hellesoy, low)_`
- [`AH-009` — Replay scenario asserts the same status twice and no-ops its non-repetition claim](low/AH-009-aslak-hellesoy.md) `_(aslak-hellesoy, low)_`
- [`CSD-009` — 5xx breach-check scenario passes coincidentally and cannot detect the CSD-001 defect](low/CSD-009-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bdd-step-definition-quality`. Evidence at HEAD ec065a7: `features/step-definitions/PasswordSteps.ts:384`. Fix: Make REQ-EA-317's transaction and token-consumed Thens observable: run this scenario against a SQLite-backed World (real transactions) with a fault-injection hook, and assert both the happy commit and rollback-on-failure; implement 'the token is consumed' by replaying the token and expecting 410. (effort M). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** P20a: REQ-EA-317 now runs against a SQLite-backed PasswordWorld with real SqlTransaction and a fault-injection hook; the token-consumed Then replays the token and expects 410; a companion rollback scenario asserts the token, password and session revocation roll back together. Mutation: bypassing withTransaction in confirmReset fails the rollback scenario.
