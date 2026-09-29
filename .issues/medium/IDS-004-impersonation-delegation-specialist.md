---
ID: "IDS-004"
Title: "endedBy=\"expired\" is declared but nothing ever sets it; audit trail reports dead episodes as active"
Level: medium
Category: "compliance"
Status: ready-for-agent
Package: "admin"
Source: "packages/admin/src/ImpersonationRecords.ts:36"
Auditor: "impersonation-delegation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# IDS-004 — endedBy="expired" is declared but nothing ever sets it; audit trail reports dead episodes as active

`MEDIUM` · `compliance` · `admin` · reported by **Impersonation & Delegation Specialist** (`impersonation-delegation-specialist`)

Status: **ready-for-agent**

## Summary

BEH-EA-215 names three enders - stopImpersonating, forceStop, or hard-expiry observation - but only the first two exist. An admin who never calls stopImpersonating leaves an episode row with `endedAt: null` forever after the session's hard expiry (max 1h by default), so `list({active:true})` - the support-ops kill-switch view per BEH-EA-219 - shows stale entries, and the audit trail's notion of 'active impersonation' diverges from reality in the exact scenario (walk-away admin) incident response cares most about.

## Evidence

Source: `packages/admin/src/ImpersonationRecords.ts:36`

```
* plugin produces yet: nothing here observes a session's hard expiry and
* calls `endEpisode(id, "expired")` on its behalf, so a naturally-expired
* episode stays reported as `active` (BEH-EA-219) until a real
```

## Recommended fix

Either compute liveness in `list`/`findBySessionId` by joining the session's absoluteExpiresAt, or add a small reaper (hook or scheduled effect) that calls endEpisode(id, "expired") for rows whose session expiry has passed; add a BDD scenario for expiry closing an episode.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 71/100), domain: Impersonation & Delegation
- Full dossier: [`impersonation-delegation-specialist`](../../.reports/impersonation-delegation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-005` — Zero tamper-evidence on the one durable audit table — history is rewritable by anyone with SQL access](medium/ALF-005-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`ESS-006` — Admin impersonation history query is unpaginated and unstreamed: SELECT * ordered, whole table per call](medium/ESS-006-effect-stream-specialist.md) `_(effect-stream-specialist, medium)_`
- [`ESA-008` — The 'expired' ended-by path is declared but never produced, so durable impersonation audit episodes are never closed by expiry](low/ESA-008-event-sourcing-audit-trail-specialist.md) `_(event-sourcing-audit-trail-specialist, low)_`
- [`IDS-002` — No tenant or organization scoping anywhere in the impersonation path](medium/IDS-002-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`JR-011` — Naturally-expired impersonation episodes stay 'active' forever: the expired EndedBy value has no producing code path](info/JR-011-justin-richer.md) `_(justin-richer, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `admin-impersonation-lifecycle`. Evidence at HEAD ec065a7: `packages/admin/src/ImpersonationRecords.ts:32`. Fix: Record each episode's hard expiry and close expired episodes as endedBy="expired" — lazily on every read and via an exported sweep — publishing the stopped event from the same path. (effort M). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.
