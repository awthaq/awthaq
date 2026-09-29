---
ID: "DTWS-005"
Title: "spec/roadmap.md contradicts itself: current-state paragraph says M4+ is implemented, gate-status section says no milestone has begun"
Level: medium
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "spec/roadmap.md:84"
Auditor: "documentation-technical-writing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DTWS-005 — spec/roadmap.md contradicts itself: current-state paragraph says M4+ is implemented, gate-status section says no milestone has begun

`MEDIUM` · `docs` · `—` · reported by **Documentation & Technical Writing Specialist** (`documentation-technical-writing-specialist`)

Status: **ready-for-agent**

## Summary

Revision 1.2 (2026-09-14) correctly rewrote the current-state paragraph (line 17: 'packages/ has a real, tested implementation of every milestone through M4 ... plus Organization, Admin, and Jwt beyond the milestones originally scoped here'), but the Gate status section two pages later still asserts 'there is no code for any gate to check, and no milestone above has begun', and the gate table (lines 90-98) marks every milestone 'Not yet active'. Within one document, the status of the same fact ('has implementation begun?') is stated both ways — the update stopped halfway through the file. This is exactly the red-flag pattern of stale entries left to contradict the code.

## Evidence

Source: `spec/roadmap.md:84`

```
As of this revision, **every gate is Not yet active** — there is no code for any gate to check, and no milestone above has begun.
```

## Recommended fix

Finish the rev-1.2 pass: rewrite line 84 and the gate table to distinguish 'gates not yet mechanized/active in CI' (true) from 'no code exists to check' (false), and record it in the Change History row so the CCR audit trail stays honest.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Documentation & Spec Drift
- Full dossier: [`documentation-technical-writing-specialist`](../../.reports/documentation-technical-writing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`SFS-008` — Deferral is explicit, justified, and consistent across roadmap artifacts](info/SFS-008-saml-federation-specialist.md) `_(saml-federation-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `spec-roadmap-status-reconcile`. Evidence at HEAD ec065a7: `spec/roadmap.md:84`. Fix: Finish the rev-1.2 pass: rewrite roadmap line 84 and the gate table (lines 88-98) to separate 'implementation status' from 'gate status', deriving gate status from MM-005's gate→script mapping. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
