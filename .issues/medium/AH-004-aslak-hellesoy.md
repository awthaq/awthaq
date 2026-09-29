---
ID: "AH-004"
Title: "Given/When inversion: Given performs the action while When is a stub"
Level: medium
Category: "testing"
Status: ready-for-agent
Package: "—"
Source: "features/step-definitions/PasswordSteps.ts:164"
Auditor: "aslak-hellesoy"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-004 — Given/When inversion: Given performs the action while When is a stub

`MEDIUM` · `testing` · `—` · reported by **Aslak Hellesøy — Creator of Cucumber** (`aslak-hellesoy`)

Status: **ready-for-agent**

## Summary

In the REQ-EA-307 outline, the Given ('a sign-in attempt where {string}', PasswordSteps.ts:132) actually issues the sign-in HTTP request, and the When is an empty generator — the Gherkin narrative ('Given attempt / When signIn is called / Then 401') misrepresents what executes. The same inversion appears at PasswordSteps.ts:98–109 (Given 'a sign-up request' stores state, but the real request only happens in a different When) and SessionSteps.ts:137–139 (When 'a session is issued' is void because signUp already ran in the Given). Beyond aesthetics, this breaks the contract readers rely on: when someone edits the When expecting to change the action, nothing changes. Also in this family: 'Given no user exists with email {string}' (PasswordSteps.ts:80) neither arranges nor verifies its precondition, so the scenario would still pass if a user did exist.

## Evidence

Source: `features/step-definitions/PasswordSteps.ts:164`

```
When('"password.signIn" is called', function* () {
    yield* Effect.void;
  });
```

## Recommended fix

Move the request-issuing code from Givens into the matching Whens; make precondition Givens either arrange (delete/point at a fresh store) or assert (verify absence) the state they name.

## Context

- Auditor verdict on this domain: **needs-work** (score 51/100), domain: BDD acceptance suites
- Full dossier: [`aslak-hellesoy`](../../.reports/aslak-hellesoy/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Catch-all Given("{string}") step dispatches on substring content](medium/AH-007-aslak-hellesoy.md) `_(aslak-hellesoy, medium)_`
- [`AH-008` — Scenario text documents fiction: named sessions and emails are silently replaced in wiring](low/AH-008-aslak-hellesoy.md) `_(aslak-hellesoy, low)_`
- [`AH-009` — Replay scenario asserts the same status twice and no-ops its non-repetition claim](low/AH-009-aslak-hellesoy.md) `_(aslak-hellesoy, low)_`
- [`CSD-009` — 5xx breach-check scenario passes coincidentally and cannot detect the CSD-001 defect](low/CSD-009-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, low)_`
- [`TIR-005` — BDD step asserting the reset transaction is an empty stub](medium/TIR-005-token-introspection-revocation-specialist.md) `_(token-introspection-revocation-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bdd-step-definition-quality`. Evidence at HEAD ec065a7: `features/step-definitions/PasswordSteps.ts:132`. Fix: Move every request-issuing body from a Given into its matching When; make precondition Givens arrange state (store the attempt parameters in the World) or assert it (query the store / call an endpoint and assert absence). (effort M). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
