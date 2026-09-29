---
ID: "ESS-008"
Title: "13-events.feature's stream-behavior scenarios have no step definitions — the tests that would catch ESS-001 are unwired"
Level: medium
Category: "testing"
Status: ready-for-agent
Package: "—"
Source: "features/features/04-cross-cutting/13-events.feature:32"
Auditor: "effect-stream-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-008 — 13-events.feature's stream-behavior scenarios have no step definitions — the tests that would catch ESS-001 are unwired

`MEDIUM` · `testing` · `—` · reported by **Effect Stream Specialist** (`effect-stream-specialist`)

Status: **ready-for-agent**

## Summary

The Gherkin suite traces REQ-EA-259..277 (bounded capacity, backlog bound, publisher-never-awaits, fork isolation, durable audit record) to 13-events.feature, but features/step-definitions/ contains only Admin/Password/Session/OAuth/Passkey/Smoke worlds — per-plugin steps assert specific events were published (e.g. features/step-definitions/AdminSteps.ts:596), yet no step implements the structural scenarios: 'its underlying PubSub is inspected', 'the backlog held for that subscriber is bounded', 'the publishing fiber is not suspended', 'the audit record for that operation is still written durably'. These are precisely the executions that would have surfaced ESS-001's publish-suspension and ESS-002's missing audit table; the strongest unit coverage today is subscriber isolation (core/test/AuthEvents.test.ts:44-62, a dying subscriber verified not to affect publisher or peers), not capacity behavior.

## Evidence

Source: `features/features/04-cross-cutting/13-events.feature:32`

```
    Scenario: Publishing an event returns without waiting for any subscriber to finish handling it
      Given a subscriber to "AuthEvents" that takes a long time to handle each event
      When an event is published while that subscriber is still processing a previous event
```

## Recommended fix

Implement an EventsWorld with a controllably slow subscriber and a capacity probe: publish past capacity with a lagging consumer and assert publish latency stays bounded (fails today per ESS-001); add the REQ-EA-266/267 durable-record steps once the AuditLog lands so BEH-EA-100 stops being untestable.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: Stream & backpressure
- Full dossier: [`effect-stream-specialist`](../../.reports/effect-stream-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bdd-feature-wiring`. Evidence at HEAD ec065a7: `features/features/04-cross-cutting/13-events.feature:7`. Fix: Wire 13-events.feature fully (all 8 Rules, not just decision 36's Tier-3 happy path) with an EventsWorld that exposes a controllably slow subscriber, a capacity probe, AuditLog reads and a log capture. (effort M). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
