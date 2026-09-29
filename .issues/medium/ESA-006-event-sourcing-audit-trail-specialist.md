---
ID: "ESA-006"
Title: "Session lifecycle events are absent from the registry — revocation, the event that must never be silently dropped, is unobservable"
Level: medium
Category: "architecture"
Status: ready-for-agent
Package: "—"
Source: "spec/behaviors/13-events.md:76"
Auditor: "event-sourcing-audit-trail-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESA-006 — Session lifecycle events are absent from the registry — revocation, the event that must never be silently dropped, is unobservable

`MEDIUM` · `architecture` · `—` · reported by **Event Sourcing & Audit Trail Specialist** (`event-sourcing-audit-trail-specialist`)

Status: **ready-for-agent**

## Summary

The spec's own registry example names auth.session.issued, yet the shipped 25-tag union contains zero session tags: the Sessions core module publishes nothing (grep across packages/core/src shows publish only in Verification.ts and AuthEvents.ts itself), so sign-out, revocation, and rotation never emit an event. For an auth event stream this is the highest-value class — 'why did this session get revoked' is the persona's motivating incident question, and admin impersonation had to bolt its own started/stopped events onto the bus precisely because session events did not exist. The header's grow-as-published policy is honest, but it means the audit story scales with plugin enthusiasm, not with security need.

## Evidence

Source: `spec/behaviors/13-events.md:76`

```
"auth.user.created" | "auth.user.signedIn" | "auth.token.replay" | "auth.session.issued"
```

## Recommended fix

Publish auth.session.issued from Sessions.issue and a revoked/expired event from the revocation and throttled-touch paths, mirroring how Verification publishes token.replay on every failure. Three tags close the largest observability gap in the registry.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: event durability & audit
- Full dossier: [`event-sourcing-audit-trail-specialist`](../../.reports/event-sourcing-audit-trail-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ESA-001` — BEH-EA-100's durable audit table does not exist anywhere — every security event is process-local and dies with the process](high/ESA-001-event-sourcing-audit-trail-specialist.md) `_(event-sourcing-audit-trail-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `session-lifecycle-events`. Already fixed by commit 45325bb (partial). Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:90`. Fix: Move session lifecycle publication into the Sessions service itself (both layers) so every issuance/revocation path — OAuth, passkey, admin impersonation, sign-out, revokeAll — emits, with a reason, and drop the plugin-level duplicates in Password. (effort M). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
