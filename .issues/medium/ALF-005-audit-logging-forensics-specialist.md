---
ID: "ALF-005"
Title: "Zero tamper-evidence on the one durable audit table — history is rewritable by anyone with SQL access"
Level: medium
Category: "security"
Status: ready-for-human
Package: "admin"
Source: "packages/admin/src/ImpersonationRecords.ts:243"
Auditor: "audit-logging-forensics-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ALF-005 — Zero tamper-evidence on the one durable audit table — history is rewritable by anyone with SQL access

`MEDIUM` · `security` · `admin` · reported by **Audit Logging & Forensics Specialist** (`audit-logging-forensics-specialist`)

Status: **ready-for-human**

## Summary

admin_impersonation is a plain mutable table in the same database as application data: no append-only constraint, no hash chain over rows, no write-once destination, no external shipper. The application-level discipline is decent (INSERT-only create; the single UPDATE is restricted to closing an open episode via the endedAt IS NULL guard), but the persona's core threat — a compromised admin or DBA, possibly the investigation's subject — can UPDATE reason/adminUserId/targetUserId, backdate startedAt, or DELETE rows, and the forgery is undetectable. An audit trail a privileged actor can silently rewrite provides repudiation protection on paper only.

## Evidence

Source: `packages/admin/src/ImpersonationRecords.ts:243`

```
          UPDATE admin_impersonation SET endedAt = ${r.endedAt}, endedBy = ${r.endedBy}
          WHERE sessionId = ${r.sessionId} AND endedAt IS NULL
```

## Recommended fix

Minimum viable tamper-evidence for a same-DB table: maintain a per-row hash chain (row_hash = H(prev_hash || canonical row bytes) in an insert-only column, verified by a periodic job that alerts on breaks), and ship an export subscriber that mirrors rows to an external append-only sink the application cannot write.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 35/100), domain: Audit trail & forensics
- Full dossier: [`audit-logging-forensics-specialist`](../../.reports/audit-logging-forensics-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ESS-006` — Admin impersonation history query is unpaginated and unstreamed: SELECT * ordered, whole table per call](medium/ESS-006-effect-stream-specialist.md) `_(effect-stream-specialist, medium)_`
- [`ESA-008` — The 'expired' ended-by path is declared but never produced, so durable impersonation audit episodes are never closed by expiry](low/ESA-008-event-sourcing-audit-trail-specialist.md) `_(event-sourcing-audit-trail-specialist, low)_`
- [`IDS-002` — No tenant or organization scoping anywhere in the impersonation path](medium/IDS-002-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-004` — endedBy="expired" is declared but nothing ever sets it; audit trail reports dead episodes as active](medium/IDS-004-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`JR-011` — Naturally-expired impersonation episodes stay 'active' forever: the expired EndedBy value has no producing code path](info/JR-011-justin-richer.md) `_(justin-richer, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `admin-audit-integrity`. Evidence at HEAD ec065a7: `packages/admin/src/ImpersonationRecords.ts:242`. Fix: Ship DB-level immutability triggers plus a shared HMAC hash-chain for durable audit tables (admin_impersonation, audit_log). (effort L). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-human.
