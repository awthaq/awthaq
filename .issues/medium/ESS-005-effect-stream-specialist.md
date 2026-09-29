---
ID: "ESS-005"
Title: "Sessions.list silently truncates at 200 rows and discards the repository's nextCursor"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/Sessions.ts:570"
Auditor: "effect-stream-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-005 — Sessions.list silently truncates at 200 rows and discards the repository's nextCursor

`MEDIUM` · `correctness` · `core` · reported by **Effect Stream Specialist** (`effect-stream-specialist`)

Status: **ready-for-agent**

## Summary

The repository exposes correct keyset pagination (Page<A> with nextCursor, packages/sql/src/Repositories.ts:45-47, DEFAULT_PAGE_SIZE 50, tested against BEH-EA-036), but its only consumer fetches exactly one page of LIST_PAGE_SIZE = 200 and drops page.nextCursor entirely: a user with more than 200 sessions receives an incomplete device list with no signal that rows were omitted — a user-facing correctness bug and, from the streaming perspective, the canonical case for a page-draining Stream (Stream.paginate-style unfold over listByUser(cursor)). The in-memory layer is unbounded while the SQL layer truncates, so behavior also differs by Layer. The comment at packages/core/src/Sessions.ts:417 admits the ceiling is a stopgap ('real UI-facing pagination (BEH-EA-036) is a repository-level concern this Shape doesn't itself expose').

## Evidence

Source: `packages/core/src/Sessions.ts:570`

```
    const list: SessionsShape["list"] = (userId, current) =>
      repo.listByUser(userId, undefined, LIST_PAGE_SIZE).pipe(
```

## Recommended fix

Either drain all pages through a Stream.unfold/successor loop bounded by a sane maximum, or extend SessionsShape.list to surface the cursor; at minimum, log or fail when page.nextCursor is Some so truncation is never silent.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: Stream & backpressure
- Full dossier: [`effect-stream-specialist`](../../.reports/effect-stream-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-list-correctness`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:641`. Fix: Make Sessions.list return exactly the user's live (non-tombstoned, non-expired) sessions, newest-activity first, in both layers, and stop server handlers from using list for keyed lookups. (effort M). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.
