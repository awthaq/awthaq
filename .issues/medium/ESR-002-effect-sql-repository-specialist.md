---
ID: "ESR-002"
Title: "Session supersede path commits delete and insert as two unwrapped statements"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/Sessions.ts:433"
Auditor: "effect-sql-repository-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESR-002 — Session supersede path commits delete and insert as two unwrapped statements

`MEDIUM` · `correctness` · `core` · reported by **Effect SQL Repository Specialist** (`effect-sql-repository-specialist`)

Status: **ready-for-agent**

## Summary

`Sessions.layerSql.issue` deletes the superseded session and then inserts the replacement as two independent autocommitted statements. A failure (SqlError, process death) between them leaves the old session revoked with no new session issued — the user is silently signed out with nothing in hand. ADR-EA-016 revision 1.1 itself names this exact 'unwrapped supersedes precedent' as the race-prone pattern it abandoned for verification-token issuing in favor of one atomic statement; the session path still carries it.

## Evidence

Source: `packages/core/src/Sessions.ts:433`

```
if (input.supersedes !== undefined) {
        yield* repo.delete(input.supersedes).pipe(Effect.orDie);
      }
```

## Recommended fix

Wrap the delete+insert pair in `sql.withTransaction`, or invert the order (insert first, delete after success) so the worst case is a transient extra live session rather than a lost one.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 76/100), domain: SQL persistence layer
- Full dossier: [`effect-sql-repository-specialist`](../../.reports/effect-sql-repository-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `session-supersede-atomicity`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:671`. Fix: Make issue(supersedes) one atomic unit in both layers: SQL tombstone+insert inside one transaction; memory tombstone+insert inside one Ref.modify. (effort M). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.
