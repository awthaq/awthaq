---
ID: "SEA-003"
Title: "File-backed SQLite quickstart exists but WAL, backup, and checkpointing are undocumented"
Level: low
Category: "dx"
Status: resolved
Package: "—"
Source: "spec/appendices/01-password-signup-to-session-view.md:51"
Auditor: "sqlite-embedded-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SEA-003 — File-backed SQLite quickstart exists but WAL, backup, and checkpointing are undocumented

`LOW` · `dx` · `—` · reported by **SQLite Embedded Auth Specialist** (`sqlite-embedded-auth-specialist`)

Status: **resolved**

## Summary

The spec appendix is the only runnable-looking file-backed SQLite wiring in the repo, and it stops at opening the database. WAL mode (driver default, SqliteClient.ts:151), the resulting -wal/-shm sidecar files, checkpoint behavior, the driver's backup() helper for consistent live-file backup, and busy_timeout sizing are never mentioned anywhere in packages/, spec/, examples/, or README.md — a grep for WAL/checkpoint across the repo returns nothing outside node_modules and research/. An embedded operator deploying auth.db gets WAL whether they know it or not, and will plausibly copy a live database file mid-write, which WAL makes safe only via proper backup.

## Evidence

Source: `spec/appendices/01-password-signup-to-session-view.md:51`

```
const Sql = SqliteClient.layer({ filename: "auth.db" })
```

## Recommended fix

Add a short embedded-deployment guide: what WAL default means operationally, how to back up a live auth.db (driver backup()), checkpoint tuning, and the single-instance constraint. Consider surfacing SqliteClientConfig options (disableWAL, busyTimeout) at whatever composition-root helper awthaq eventually ships.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 70/100), domain: Embedded SQLite Persistence
- Full dossier: [`sqlite-embedded-auth-specialist`](../../.reports/sqlite-embedded-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `sqlite-ops-docs`. Evidence at HEAD ec065a7: `spec/appendices/01-password-signup-to-session-view.md:51`. Fix: Add an embedded-SQLite operations section: WAL default and -wal/-shm sidecars, live backup via the client's `backup(destination)`, checkpointing, busy timeout, single-writer/single-instance constraint. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** packages/sql/README.md 'Embedded SQLite in production': WAL default and -wal/-shm sidecars (never copy auth.db alone), live backup via SqliteClient.backup, checkpointing (wal_checkpoint(TRUNCATE)), busy timeout, one writer / one instance / local disk. spec/appendices/01-password-signup-to-session-view.md links it.
