---
ID: "BDD-008"
Title: "SessionSteps Then-step hardcodes actor 'alice' inside a parameterized assertion"
Level: low
Category: "correctness"
Status: resolved
Package: "—"
Source: "features/step-definitions/SessionSteps.ts:55"
Auditor: "bdd-gherkin-acceptance-testing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BDD-008 — SessionSteps Then-step hardcodes actor 'alice' inside a parameterized assertion

`LOW` · `correctness` · `—` · reported by **BDD/Gherkin Acceptance Testing Specialist** (`bdd-gherkin-acceptance-testing-specialist`)

Status: **resolved**

## Summary

The Then step 'she sees {int} sessions, each with its own userAgent...' receives no actor argument yet reads getLastResponse("alice"), so any scenario reusing the step for a different actor would assert against alice's last response — a silent wrong-subject pass. It is currently safe only because the single call site (07-sessions.feature:187) uses alice; the same file's sibling steps correctly thread the name parameter. The cookie-attribute Thens (lines 141-160) have the same hardcoding.

## Evidence

Source: `features/step-definitions/SessionSteps.ts:55`

```
const response = yield* getLastResponse("alice");
```

## Recommended fix

Parameterize the actor: 'she sees {int} sessions...' should resolve the acting actor via the World (e.g. store the acting name at Given time or add {string}), and the cookie Thens should read the last response cell rather than the literal alice.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: BDD acceptance testing
- Full dossier: [`bdd-gherkin-acceptance-testing-specialist`](../../.reports/bdd-gherkin-acceptance-testing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bdd-step-definition-quality`. Evidence at HEAD ec065a7: `features/step-definitions/SessionSteps.ts:52`. Fix: Introduce a 'current actor' cell in the World set by every step that names an actor, and have pronoun/implicit-subject Thens read it instead of the literal 'alice'. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** P20a: no Then hardcodes getActor(alice) in the session and password steps; pronoun steps resolve through the registry current actor (the one remaining literal is a scenario that names alice).
