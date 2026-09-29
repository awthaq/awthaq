---
ID: "AH-009"
Title: "Replay scenario asserts the same status twice and no-ops its non-repetition claim"
Level: low
Category: "testing"
Status: ready-for-agent
Package: "—"
Source: "features/step-definitions/PasswordSteps.ts:462"
Auditor: "aslak-hellesoy"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-009 — Replay scenario asserts the same status twice and no-ops its non-repetition claim

`LOW` · `testing` · `—` · reported by **Aslak Hellesøy — Creator of Cucumber** (`aslak-hellesoy`)

Status: **ready-for-agent**

## Summary

REQ-EA-321's scenario contains three Thens: the first and third both assert response.status === 410 (lines 452–455 and 466–472 — the identical check twice), while the middle one, the only clause that adds information ('not performed a second time'), asserts nothing. The scenario reads as three independent guarantees but delivers one. This is the conjunction-step anti-pattern in miniature: multiple And-ed claims where the extra clauses are either duplicates or vapor, inflating apparent coverage in the test report.

## Evidence

Source: `features/step-definitions/PasswordSteps.ts:462`

```
Then("the replayed action is not performed a second time", function* () {
    yield* Effect.void;
  });
```

## Recommended fix

Make the middle Then meaningful (e.g. assert publishedEvents contains no second success event, or the verification row's consumed-at is unchanged) and drop the duplicate 410 assertion, or fold the scenario to a single Then.

## Context

- Auditor verdict on this domain: **needs-work** (score 51/100), domain: BDD acceptance suites
- Full dossier: [`aslak-hellesoy`](../../.reports/aslak-hellesoy/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-004` — Given/When inversion: Given performs the action while When is a stub](medium/AH-004-aslak-hellesoy.md) `_(aslak-hellesoy, medium)_`
- [`AH-007` — Catch-all Given("{string}") step dispatches on substring content](medium/AH-007-aslak-hellesoy.md) `_(aslak-hellesoy, medium)_`
- [`AH-008` — Scenario text documents fiction: named sessions and emails are silently replaced in wiring](low/AH-008-aslak-hellesoy.md) `_(aslak-hellesoy, low)_`
- [`CSD-009` — 5xx breach-check scenario passes coincidentally and cannot detect the CSD-001 defect](low/CSD-009-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, low)_`
- [`TIR-005` — BDD step asserting the reset transaction is an empty stub](medium/TIR-005-token-introspection-revocation-specialist.md) `_(token-introspection-revocation-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `bdd-step-definition-quality`. Evidence at HEAD ec065a7: `features/step-definitions/PasswordSteps.ts:473`. Fix: Make 'the replayed action is not performed a second time' observable: snapshot the published-events log (and the user's verified state) before the replay and assert the replay added only `auth.token.replay` and changed no user state. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
