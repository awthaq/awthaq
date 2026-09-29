---
ID: "SMS-006"
Title: "SQL issue's supersede is a non-transactional delete-then-insert"
Level: low
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:433"
Auditor: "session-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SMS-006 — SQL issue's supersede is a non-transactional delete-then-insert

`LOW` · `correctness` · `core` · reported by **Session Management Specialist** (`session-management-specialist`)

Status: **resolved**

## Summary

The shape's contract says supersedes 'deletes that row in the same call rather than leaving both live', and Repositories.ts's own header (lines 5-11) states repositories open no transaction — the calling domain service holds that boundary. layerSql never opens one: it deletes the superseded row (line 433), then separately inserts the new row (lines 448-460). A failure or crash between the two statements leaves the user with zero sessions. That fails closed (the user must re-authenticate), which is why this is low, but the 'same call' atomicity the doc promises does not exist on the SQL path.

## Evidence

Source: `packages/core/src/Sessions.ts:433`

```
if (input.supersedes !== undefined) {
        yield* repo.delete(input.supersedes).pipe(Effect.orDie);
      }
```

## Recommended fix

Wrap the supersedes-delete plus new-row insert in a single SqlClient transaction inside layerSql, or push an atomic swapIntoPlace operation onto SessionsRepositoryShape so the delete and insert commit together.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: session lifecycle
- Full dossier: [`session-management-specialist`](../../.reports/session-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `session-supersede-atomicity`. Duplicate of `ESR-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:671`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.
