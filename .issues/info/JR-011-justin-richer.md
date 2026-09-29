---
ID: "JR-011"
Title: "Naturally-expired impersonation episodes stay 'active' forever: the expired EndedBy value has no producing code path"
Level: info
Category: "docs"
Status: resolved
Package: "admin"
Source: "packages/admin/src/ImpersonationRecords.ts:36"
Auditor: "justin-richer"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JR-011 — Naturally-expired impersonation episodes stay 'active' forever: the expired EndedBy value has no producing code path

`INFO` · `docs` · `admin` · reported by **Justin Richer — OAuth2/OIDC Contributor, Co-author of "OAuth 2 in Action"** (`justin-richer`)

Status: **resolved**

## Summary

The limitation is honestly documented (ImpersonationRecords.ts:31-40): BEH-EA-215 allows endedBy to be set by 'stopImpersonating, forceStop, or hard-expiry observation', but no observer exists, so the durable audit trail — the compliance artifact that outlives the session row — shows expired support episodes as ongoing indefinitely until someone calls stop/forceStop on an already-dead session. For an audit trail whose stated purpose is answering 'who impersonated whom, when, and why', the unbounded-active window weakens exactly the property the table exists for. The plugin's own docs acknowledge it, so this is a prioritization note, not a hidden defect.

## Evidence

Source: `packages/admin/src/ImpersonationRecords.ts:36`

```
* plugin produces yet: nothing here observes a session's hard expiry and
 * calls `endEpisode(id, "expired")` on its behalf, so a naturally-expired
 * episode stays reported as `active` (BEH-EA-219) until a real
```

## Recommended fix

Cheap closure: when list(active=true) or list() observes rows whose session hard-expiry has passed, close them as "expired" lazily; or run a tiny scheduled sweep. Even a read-time reconciliation makes the audit trail truthful without new infrastructure.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth protocol semantics
- Full dossier: [`justin-richer`](../../.reports/justin-richer/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-005` — Zero tamper-evidence on the one durable audit table — history is rewritable by anyone with SQL access](medium/ALF-005-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`ESS-006` — Admin impersonation history query is unpaginated and unstreamed: SELECT * ordered, whole table per call](medium/ESS-006-effect-stream-specialist.md) `_(effect-stream-specialist, medium)_`
- [`ESA-008` — The 'expired' ended-by path is declared but never produced, so durable impersonation audit episodes are never closed by expiry](low/ESA-008-event-sourcing-audit-trail-specialist.md) `_(event-sourcing-audit-trail-specialist, low)_`
- [`IDS-002` — No tenant or organization scoping anywhere in the impersonation path](medium/IDS-002-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-004` — endedBy="expired" is declared but nothing ever sets it; audit trail reports dead episodes as active](medium/IDS-004-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `admin-impersonation-lifecycle`. Duplicate of `IDS-004` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/admin/src/ImpersonationRecords.ts:32`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `IDS-004-impersonation-delegation-specialist` — closed by its fix (see that issue's Resolved comment).
