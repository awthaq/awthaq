---
ID: "BDD-007"
Title: "World harness helpers duplicated per plugin instead of shared"
Level: low
Category: "dx"
Status: ready-for-agent
Package: "—"
Source: "features/step-definitions/SessionWorld.ts:52"
Auditor: "bdd-gherkin-acceptance-testing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BDD-007 — World harness helpers duplicated per plugin instead of shared

`LOW` · `dx` · `—` · reported by **BDD/Gherkin Acceptance Testing Specialist** (`bdd-gherkin-acceptance-testing-specialist`)

Status: **ready-for-agent**

## Summary

The one-World-per-test-file isolation is sound, but the harness beneath it is copy-per-World: cookieFrom is defined four times (PasswordWorld.ts:184, SessionWorld.ts:158, AdminWorld.ts:169, PasskeyWorld.ts:262), STRONG_PASSWORD twice (PasswordWorld.ts:260, SessionWorld.ts:129), and SessionWorld's mailer comment admits it mirrors PasswordWorld's. The interview-probe ideal — ten plugins not producing ten near-duplicate fixtures — is met at the step-text layer but violated one layer down; a fix to cookie parsing or password policy must be applied N times and can silently diverge.

## Evidence

Source: `features/step-definitions/SessionWorld.ts:52`

```
 * Mirrors `PasswordWorld.ts`'s own `capturingMailer` — a capture cell
```

## Recommended fix

Extract cookieFrom, STRONG_PASSWORD, the capturing mailer, TestServices, and the letForkedFibersRun quiescence helper into a features/step-definitions/shared/ module imported by every World, keeping each World's Layer composition and actor registry per-file.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: BDD acceptance testing
- Full dossier: [`bdd-gherkin-acceptance-testing-specialist`](../../.reports/bdd-gherkin-acceptance-testing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bdd-step-definition-quality`. Evidence at HEAD ec065a7: `features/step-definitions/SessionWorld.ts:71`. Fix: Extract the shared harness (cookieFrom, STRONG_PASSWORD, capturingMailer factory, TestServices, letForkedFibersRun, request helper, named-actor/session registry) into features/step-definitions/shared/ and import it from every World. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
