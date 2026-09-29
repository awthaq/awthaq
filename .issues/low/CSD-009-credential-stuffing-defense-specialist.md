---
ID: "CSD-009"
Title: "5xx breach-check scenario passes coincidentally and cannot detect the CSD-001 defect"
Level: low
Category: "testing"
Status: resolved
Package: "—"
Source: "features/step-definitions/PasswordSteps.ts:532"
Auditor: "credential-stuffing-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSD-009 — 5xx breach-check scenario passes coincidentally and cannot detect the CSD-001 defect

`LOW` · `testing` · `—` · reported by **Credential Stuffing Defense Specialist** (`credential-stuffing-defense-specialist`)

Status: **resolved**

## Summary

REQ-EA-324 (15-password.feature:207-211) claims a timeout, a 5xx, and a malformed response are each 'treated uniformly as unavailable'. The Given step is an empty no-op (above); the real wiring happens in the When step, which does serve a genuine 503 via respondingWith(503, ...) (line 548) and a malformed body (line 556). But under the default allow posture, 'treated as unavailable' and 'treated as not-breached' produce the same sign-up success, so the assertion (sign-up proceeds, line 520-523) cannot distinguish them — and the 503 currently takes the not-breached path, not the unavailable path. No scenario pairs a 5xx with `onUnavailable: "reject"`, which is precisely the configuration where the uniform-treatment claim fails (CSD-001).

## Evidence

Source: `features/step-definitions/PasswordSteps.ts:532`

```
    function* () {
      yield* Effect.void;
    },
```

## Recommended fix

Make the scenario observable: under `onUnavailable: "reject"`, assert sign-up is rejected for a 5xx response (this fails today, exposing CSD-001); optionally surface a distinguishable signal (metric/event) for the unavailable branch under the default posture.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: credential stuffing defense
- Full dossier: [`credential-stuffing-defense-specialist`](../../.reports/credential-stuffing-defense-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-004` — Given/When inversion: Given performs the action while When is a stub](medium/AH-004-aslak-hellesoy.md) `_(aslak-hellesoy, medium)_`
- [`AH-007` — Catch-all Given("{string}") step dispatches on substring content](medium/AH-007-aslak-hellesoy.md) `_(aslak-hellesoy, medium)_`
- [`AH-008` — Scenario text documents fiction: named sessions and emails are silently replaced in wiring](low/AH-008-aslak-hellesoy.md) `_(aslak-hellesoy, low)_`
- [`AH-009` — Replay scenario asserts the same status twice and no-ops its non-repetition claim](low/AH-009-aslak-hellesoy.md) `_(aslak-hellesoy, low)_`
- [`TIR-005` — BDD step asserting the reset transaction is an empty stub](medium/TIR-005-token-introspection-revocation-specialist.md) `_(token-introspection-revocation-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `bdd-step-definition-quality`. Evidence at HEAD ec065a7: `features/step-definitions/PasswordSteps.ts:541`. Fix: Move the per-case failure wiring into the Given and add an acceptance-level fail-closed counterpart: a Scenario Outline over timeout/5xx/malformed under onUnavailable: "reject" expecting 422, which distinguishes 'unavailable' from 'not breached'. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** P20a: the breach-provider failure Given now arranges the failing HttpClient in the World and the When issues the request; a Scenario Outline over timeout/5xx/malformed under onUnavailable reject expects 422. Mutation: removing filterStatusOk fails the 5xx row.
