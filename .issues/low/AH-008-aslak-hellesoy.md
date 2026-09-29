---
ID: "AH-008"
Title: "Scenario text documents fiction: named sessions and emails are silently replaced in wiring"
Level: low
Category: "testing"
Status: ready-for-agent
Package: "—"
Source: "features/step-definitions/PasswordSteps.ts:322"
Auditor: "aslak-hellesoy"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-008 — Scenario text documents fiction: named sessions and emails are silently replaced in wiring

`LOW` · `testing` · `—` · reported by **Aslak Hellesøy — Creator of Cucumber** (`aslak-hellesoy`)

Status: **ready-for-agent**

## Summary

REQ-EA-317's Given names session "s1", but the step discards the parameter (leading underscore, never creates a session under that name) and the matching Then 'session "s1" is revoked' (line 364) is verified by an indirect proxy — POSTing /change-password with a re-derived pre-reset cookie and expecting 401 — with an in-code comment admitting the cookie is 're-derived here'. Similarly, feature text says alice@example.com while the wiring signs up alice-reset@example.com. A stakeholder reading the .feature cannot form a true picture of what 'session s1 is revoked' was verified by; the named entities in the specification are props, not state.

## Evidence

Source: `features/step-definitions/PasswordSteps.ts:322`

```
function* (name: string, _sessionName: string, _forName: string) {
```

## Recommended fix

Either make the World track sessions under the names the Gherkin uses (a sessions map keyed by name — SessionSteps.ts already does this correctly via aliasActor/sessionIdOf) or rewrite the scenario text to name only entities the harness genuinely creates.

## Context

- Auditor verdict on this domain: **needs-work** (score 51/100), domain: BDD acceptance suites
- Full dossier: [`aslak-hellesoy`](../../.reports/aslak-hellesoy/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-004` — Given/When inversion: Given performs the action while When is a stub](medium/AH-004-aslak-hellesoy.md) `_(aslak-hellesoy, medium)_`
- [`AH-007` — Catch-all Given("{string}") step dispatches on substring content](medium/AH-007-aslak-hellesoy.md) `_(aslak-hellesoy, medium)_`
- [`AH-009` — Replay scenario asserts the same status twice and no-ops its non-repetition claim](low/AH-009-aslak-hellesoy.md) `_(aslak-hellesoy, low)_`
- [`CSD-009` — 5xx breach-check scenario passes coincidentally and cannot detect the CSD-001 defect](low/CSD-009-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, low)_`
- [`TIR-005` — BDD step asserting the reset transaction is an empty stub](medium/TIR-005-token-introspection-revocation-specialist.md) `_(token-introspection-revocation-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bdd-step-definition-quality`. Evidence at HEAD ec065a7: `features/step-definitions/PasswordSteps.ts:320`. Fix: Track sessions by the Gherkin name in the Password World (as SessionWorld's aliasActor/sessionIdOf already do) and use the emails the feature text names; per-scenario World isolation removes the need for suffixed emails. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
