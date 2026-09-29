---
ID: "RRS-004"
Title: "layerSql issue({supersedes}) is an unwrapped delete-then-insert, the exact pattern ADR-EA-016 rejected"
Level: medium
Category: "correctness"
Status: resolved
Package: "—"
Source: "spec/decisions/016-verification-sql-claiming.md:48"
Auditor: "refresh-token-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRS-004 — layerSql issue({supersedes}) is an unwrapped delete-then-insert, the exact pattern ADR-EA-016 rejected

`MEDIUM` · `correctness` · `—` · reported by **Refresh Token Rotation Specialist** (`refresh-token-rotation-specialist`)

Status: **resolved**

## Summary

Sessions.layerSql.issue runs repo.delete(supersedes) (Sessions.ts:433) and repo.insert (Sessions.ts:460) as two independent effects with no SqlTransaction wrapper, even though the repository header (packages/sql/src/Repositories.ts:6-10) states the calling domain service owns that boundary and this caller never takes it. ADR-EA-016 revision 1.1 abandoned this exact two-statement shape for Verification.issue after a code review found the race, and the ADR text explicitly names Sessions' supersedes as the precedent it moved away from. A failure, timeout, or crash after the delete but before the insert destroys the superseded session without creating the replacement — the user is locked out of that sign-in with the old row already gone.

## Evidence

Source: `spec/decisions/016-verification-sql-claiming.md:48`

```
matching `Sessions.layerSql`'s own unwrapped `supersedes` precedent
```

## Recommended fix

Wrap the supersedes delete and the new-session insert in sql.withTransaction (the mechanism ADR-EA-016 already validated), or collapse to a single statement pattern like the verification upsert.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: Refresh & Token Rotation
- Full dossier: [`refresh-token-rotation-specialist`](../../.reports/refresh-token-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `session-supersede-atomicity`. Already fixed by commit 9017a8a (partial: delete -> tombstone). Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:671`. Fix: Wrap the tombstone + insert pair in one transaction via the SqlTransaction port, and update ADR-016's reference. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Closed with ESR-002 (same fix): tombstone+insert in one sql.withTransaction via SqlClient (not the SqlTransaction port: Accounts.layerSql precedent, and Sessions.layerSql already needs SqlClient through its repository, so no composition root changed); ADR-EA-016 rev 1.3 no longer cites an unwrapped precedent; BEH-EA-053 states atomic supersession.
