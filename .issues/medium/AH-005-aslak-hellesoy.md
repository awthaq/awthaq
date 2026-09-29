---
ID: "AH-005"
Title: "Sessions feature is 75% @skip'd — harness cannot observe what the spec demands"
Level: medium
Category: "testing"
Status: resolved
Package: "—"
Source: "features/features/02-domain/07-sessions.feature:20"
Auditor: "aslak-hellesoy"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-005 — Sessions feature is 75% @skip'd — harness cannot observe what the spec demands

`MEDIUM` · `testing` · `—` · reported by **Aslak Hellesøy — Creator of Cucumber** (`aslak-hellesoy`)

Status: **resolved**

## Summary

18 of the sessions feature's 24 scenarios are skipped (34 of 127 across all wired features). The pruning is honest — each skip carries a rationale comment — but the rationales ('needs direct repository/row access', 'would need to intercept the real structured logger', 'telemetry-capture claim this suite has no proven mechanism to assert') all describe World-capability gaps, not fundamental unobservability. The result is that the acceptance suite green-lights the session surface while its most security-critical claims (only SHA-256(secret) persisted, secret redacted in logs/spans) are exactly the ones not executing. The skip comments even point at where the assertions belong: the World already reuses packages/core's memory repositories, so row-level observation is one accessor away.

## Evidence

Source: `features/features/02-domain/07-sessions.feature:20`

```
@skip
    @REQ-EA-136
    Scenario: Issuing a session returns a token composed of a public id and a secret
```

## Recommended fix

Extend SessionWorld with a repository-read handle and a structured-log capture (the capturingMailer pattern already in PasswordWorld generalizes to both), then un-skip the 18 scenarios. Keep @skip only for genuinely non-deterministic claims (the timing side-channel scenarios are legitimate prunes).

## Context

- Auditor verdict on this domain: **needs-work** (score 51/100), domain: BDD acceptance suites
- Full dossier: [`aslak-hellesoy`](../../.reports/aslak-hellesoy/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BDD-009` — Sessions acceptance file is 75% @skip — mostly intent, little executable verification](info/BDD-009-bdd-gherkin-acceptance-testing-specialist.md) `_(bdd-gherkin-acceptance-testing-specialist, info)_`
- [`SMS-008` — The only wire-testable BEH-EA-053 scenario is @skip'd, leaving privilege-change rotation unguarded](low/SMS-008-session-management-specialist.md) `_(session-management-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bdd-skip-debt`. Evidence at HEAD ec065a7: `features/features/02-domain/07-sessions.feature:20`. Fix: Extend SessionWorld with (a) a repository read handle, (b) a structured-log/span capture, (c) TestClock-driven time control, then un-skip every sessions scenario whose skip rationale is a World-capability gap; keep @skip only for timing side-channel (REQ-EA-157..159) and cookie-browser-behaviour (REQ-EA-156) prunes. (effort L). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** P20a: 07-sessions.feature runs 21 of 26 scenarios. SessionWorld now has real SQLite rows (readable session rows), a TestClock started at the real now, RedactionGuard log/span capture and an in-flight gate endpoint. The 5 remaining skips are email change (no changeEmail capability), the browser cookie jar (REQ-EA-156) and constant-time timing (157-159), each naming its covering test.
