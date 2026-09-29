---
ID: "SMS-008"
Title: "The only wire-testable BEH-EA-053 scenario is @skip'd, leaving privilege-change rotation unguarded"
Level: low
Category: "testing"
Status: resolved
Package: "—"
Source: "features/features/02-domain/07-sessions.feature:167"
Auditor: "session-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SMS-008 — The only wire-testable BEH-EA-053 scenario is @skip'd, leaving privilege-change rotation unguarded

`LOW` · `testing` · `—` · reported by **Session Management Specialist** (`session-management-specialist`)

Status: **resolved**

## Summary

The Gherkin Outline that pins BEH-EA-053's privilege-change semantics is pruned wholesale because its 'email change' example row names a capability that does not exist — even though its own comment concedes the 'password change' row is 'real and wire-testable'. Combined with SMS-001, the repo's only executable-guard opportunity for session rotation at privilege change is skipped, so the spec violation is invisible to both the BDD suite and any future regression run. The domain-level Sessions.test.ts has no privilege-change test either (changePassword lives in the password plugin).

## Evidence

Source: `features/features/02-domain/07-sessions.feature:167`

```
@skip
    @REQ-EA-148
    Scenario Outline: A privilege-changing operation issues a new session and deletes the superseded row
```

## Recommended fix

Restructure the Outline into a single non-outline scenario for password change (the existing capability) and implement it once SMS-001 lands; keep the email-change row out until such an endpoint exists.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: session lifecycle
- Full dossier: [`session-management-specialist`](../../.reports/session-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-005` — Sessions feature is 75% @skip'd — harness cannot observe what the spec demands](medium/AH-005-aslak-hellesoy.md) `_(aslak-hellesoy, medium)_`
- [`BDD-009` — Sessions acceptance file is 75% @skip — mostly intent, little executable verification](info/BDD-009-bdd-gherkin-acceptance-testing-specialist.md) `_(bdd-gherkin-acceptance-testing-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bdd-skip-debt`. Evidence at HEAD ec065a7: `features/features/02-domain/07-sessions.feature:167`. Fix: Split the Outline: a plain Scenario for password change (wired, runs now) and keep an @skip'd scenario (or Outline) for email change with an explicit 'no changeEmail capability' rationale. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** P20a: REQ-EA-148 is now the plain password-change scenario and runs; the email-change scenario is separate and skipped with the no-changeEmail rationale.
