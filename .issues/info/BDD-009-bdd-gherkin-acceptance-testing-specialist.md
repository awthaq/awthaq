---
ID: "BDD-009"
Title: "Sessions acceptance file is 75% @skip — mostly intent, little executable verification"
Level: info
Category: "testing"
Status: resolved
Package: "—"
Source: "features/features/02-domain/07-sessions.feature:97"
Auditor: "bdd-gherkin-acceptance-testing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BDD-009 — Sessions acceptance file is 75% @skip — mostly intent, little executable verification

`INFO` · `testing` · `—` · reported by **BDD/Gherkin Acceptance Testing Specialist** (`bdd-gherkin-acceptance-testing-specialist`)

Status: **resolved**

## Summary

18 of 24 sessions scenarios carry @skip with per-scenario rationale (TestClock propagation, concurrency control, timing side-channels, cookie-set observability), making sessions — the most security-critical domain in the catalog — the least executed wired file (6 of 24 active). The honesty of the pruning is exemplary (each skip names its reason and often the unit test that covers it, e.g. packages/core/test/Sessions.test.ts), but the acceptance net over session expiry, refresh throttling, and revocation windows is currently suspended, and the reasons cite a .scratch/shipping-gaps map rather than a durable tracking artifact.

## Evidence

Source: `features/features/02-domain/07-sessions.feature:97`

```
# force-implemented — the same unverified-TestClock-propagation reason as REQ-EA-141.
```

## Recommended fix

Move the shipping-gap ledger into a committed file (or issue tracker ids) referenced by the skip comments, and prioritize de-skipping the time-dependent cluster by wiring TestClock through the World harness — the rationale comments themselves argue the scenarios are blocked on harness capability, not on unimplementability.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: BDD acceptance testing
- Full dossier: [`bdd-gherkin-acceptance-testing-specialist`](../../.reports/bdd-gherkin-acceptance-testing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-005` — Sessions feature is 75% @skip'd — harness cannot observe what the spec demands](medium/AH-005-aslak-hellesoy.md) `_(aslak-hellesoy, medium)_`
- [`SMS-008` — The only wire-testable BEH-EA-053 scenario is @skip'd, leaving privilege-change rotation unguarded](low/SMS-008-session-management-specialist.md) `_(session-management-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `bdd-skip-debt`. Duplicate of `AH-005-aslak-hellesoy` — closed by that issue's fix. Evidence at HEAD ec065a7: `features/features/02-domain/07-sessions.feature:97`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `AH-005-aslak-hellesoy` — closed by its fix (see that issue's Resolved comment).
