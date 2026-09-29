---
ID: "ECF-007"
Title: "issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard"
Level: low
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:432"
Auditor: "effect-concurrency-fiber-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECF-007 — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard

`LOW` · `correctness` · `core` · reported by **Effect Concurrency & Fiber Specialist** (`effect-concurrency-fiber-specialist`)

Status: **resolved**

## Summary

In the SQL layer, superseding issues delete the old row (line 433) and only later insert the replacement (line 460), with no SqlTransaction wrap; the memory layer has the same two-step shape (Ref.update remove at 228, set at 257). A fiber interrupted between the steps — or a SqlError on the insert — leaves the user's prior session revoked with no new session issued: a spurious hard logout. The window is narrow and the surrounding code otherwise models interruption safety carefully, which makes the unguarded acquisition stand out.

## Evidence

Source: `packages/core/src/Sessions.ts:432`

```
if (input.supersedes !== undefined) {
        yield* repo.delete(input.supersedes).pipe(Effect.orDie);
      }
```

## Recommended fix

Wrap the delete+insert pair in SqlTransaction.withTransaction (the port the plugins already use) so the supersede is atomic, or reverse the order (insert first, then delete) with cleanup on failure; in the memory layer, collapse both mutations into one Ref.modify.

## Context

- Auditor verdict on this domain: **needs-work** (score 68/100), domain: Concurrency & Fibers
- Full dossier: [`effect-concurrency-fiber-specialist`](../../.reports/effect-concurrency-fiber-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Redundant assertion after sound narrowing in session supersedes path](low/AH-007-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`AGA-004` — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate](medium/AGA-004-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BO-005` — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login](medium/BO-005-balazs-orban.md) `_(balazs-orban, medium)_`
- [`BAM-003` — Session cutover invalidates every live better-auth session with no bridge](high/BAM-003-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`DRS-004` — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning](medium/DRS-004-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`EEM-008` — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim](low/EEM-008-effect-error-management-specialist.md) `_(effect-error-management-specialist, low)_`
- [`EOTS-004` — Session ids — the public half of a bearer credential — are interpolated into error messages that reach logs](medium/EOTS-004-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `session-supersede-atomicity`. Duplicate of `ESR-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:671`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.
