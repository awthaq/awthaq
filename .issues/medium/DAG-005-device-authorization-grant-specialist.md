---
ID: "DAG-005"
Title: "Strongest RFC 8628 design in the repo is non-normative third-party analysis"
Level: medium
Category: "architecture"
Status: resolved
Package: "—"
Source: "better-auth/05-mfa-and-verification/08-device-authorization-and-one-tap.md:104"
Auditor: "device-authorization-grant-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DAG-005 — Strongest RFC 8628 design in the repo is non-normative third-party analysis

`MEDIUM` · `architecture` · `—` · reported by **Device Authorization Grant Specialist** (`device-authorization-grant-specialist`)

Status: **resolved**

## Summary

The corpus's §A.3 polling state machine is genuinely rigorous: server-side slow_down throttling with lastPolledAt updated unconditionally (so rejected polls still count), expiry garbage-collection on first discovery, denied-row deletion on observation, and a terminal redemption that runs every fallible check before an atomic conditional consume (id + ownership + status='approved'), guaranteeing at-most-once session issuance per device code even under concurrent polls. None of this is normative: it lives in a better-auth comparison document, while MOD-EA-013's own sketch is a speculative interface stub. The gap between the repo's best design thinking and its recorded specification invites a Phase-3 implementation that re-derives (or worse, omits) the race-safety properties.

## Evidence

Source: `better-auth/05-mfa-and-verification/08-device-authorization-and-one-tap.md:104`

```
ALL fallible checks (grant authorization, user
                    lookup) complete BEFORE the destructive step —
                    ONLY THEN: ATOMIC CONDITIONAL CONSUME
```

## Recommended fix

Port §A.1–A.6 into spec/behaviors as a numbered BEH-EA range with matching invariants (state advances only pending→approved/denied; claim is compare-and-swap; redemption is a conditional consume; all fallible checks precede the destructive step), and add the client-side RFC 8628 §3.5 duty the corpus omits: on slow_down the client must increase its interval by 5 seconds.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 34/100), domain: Device Authorization Grant
- Full dossier: [`device-authorization-grant-specialist`](../../.reports/device-authorization-grant-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `device-authorization-grant`. Evidence at HEAD ec065a7: `better-auth/05-mfa-and-verification/08-device-authorization-and-one-tap.md:104`. Fix: Graduate the better-auth §A.1–A.6 polling state machine into awthaq's own spec/models/13-device-authorization.md as a 'Design constraints' section (normative intent for Phase 3), adding RFC 8628 §3.5's client slow_down +5 s duty and the BEH-EA-208/CLI-login linkage; allocate a BEH-EA range when the plugin enters a roadmap milestone. (effort M). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** spec/models/13-device-authorization.md rev 1.1: new 'Design constraints' section adopting better-auth §A.1-A.6 in awthaq's own words (state only advances pending->approved|denied; CAS approve/deny; every fallible check before an atomic conditional consume so at most one session under concurrent polls, side effects strictly after the claim; server-side slow_down with lastPolledAt updated on every poll incl. rejected ones; GC on first discovery; claim-then-decide verification, idempotent for one session; client MUST add 5s on slow_down, RFC 8628 §3.5) linked to ticket 06 (CLI login backend) and ticket 03 (BeforeSessionIssue). The model no longer calls itself speculative in its entirety; 'What is missing' and Verification updated; no BEH range allocated (none until a milestone schedules the plugin). spec:verify:strict passes.
