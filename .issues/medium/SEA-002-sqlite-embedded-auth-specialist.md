---
ID: "SEA-002"
Title: "Single-writer write path is sound but its event-loop cost and 5s busy ceiling are nowhere surfaced"
Level: medium
Category: "performance"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:74"
Auditor: "sqlite-embedded-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SEA-002 — Single-writer write path is sound but its event-loop cost and 5s busy ceiling are nowhere surfaced

`MEDIUM` · `performance` · `core` · reported by **SQLite Embedded Auth Specialist** (`sqlite-embedded-auth-specialist`)

Status: **resolved**

## Summary

Concurrent session writes are architecturally safe under SQLite: the touch compare-and-swap is one UPDATE ... RETURNING statement (Repositories.ts:424-432), the driver serializes statements over one connection behind a Semaphore(1) (SqliteClient.ts:304), and cross-process contention waits busy_timeout (default 5 seconds, SqliteClient.ts:148) inside BEGIN IMMEDIATE transactions. But node:sqlite is synchronous, so every busy wait and every statement blocks the entire Node event loop — a busy database stalls all requests, not just auth writes — and after 5 seconds callers get a SqlError that deleteUser-style Effect.orDie paths convert into process death. The 1-hour touchEvery throttle caps steady-state writes well, but session-issuance bursts at sign-in spikes still serialize, and nothing in the repo documents this ceiling or tells an operator when to move to Postgres.

## Evidence

Source: `packages/core/src/Sessions.ts:74`

```
      touchEvery: Duration.hours(1),
```

## Recommended fix

Document the embedded ceiling (writes serialize; busy waits block the loop; default 5s then error) in the deployment docs and spec appendix, size busy_timeout deliberately per deployment, and add a retry/queueing policy for SqlError under load instead of Effect.orDie on hot write paths.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 70/100), domain: Embedded SQLite Persistence
- Full dossier: [`sqlite-embedded-auth-specialist`](../../.reports/sqlite-embedded-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Redundant assertion after sound narrowing in session supersedes path](low/AH-007-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`AGA-004` — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate](medium/AGA-004-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BO-005` — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login](medium/BO-005-balazs-orban.md) `_(balazs-orban, medium)_`
- [`BAM-003` — Session cutover invalidates every live better-auth session with no bridge](high/BAM-003-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`DRS-004` — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning](medium/DRS-004-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ECF-007` — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard](low/ECF-007-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-008` — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim](low/EEM-008-effect-error-management-specialist.md) `_(effect-error-management-specialist, low)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `session-docs-accuracy`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:76`. Fix: Document the embedded-SQLite write ceiling and the move-to-Postgres signal; the retry/typed-error half rides on MA-004's decision. (effort S). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Doc: new spec/appendices/04-sqlite-embedded-deployment.md (EFAUTH-APP-04, index.yaml entry): single serialized connection, writes serialize, node:sqlite blocks the event loop, 5s busyTimeout then SqlError -> defect, what writes awthaq generates, sizing guidance, when to move to Postgres. Deferred: the bounded busy-retry (Schedule) around issue/touch is gated on MA-004's typed environmental-error channel (noted in the appendix).

**Resolved (2026-09-29):** P21a: the deferred busy-retry half landed with MA-004: Errors.retryTransient around Sessions.issue and the verify touch (see MA-004).
