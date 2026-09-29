---
ID: "PIL-004"
Title: "SQL issue(supersedes) deletes the old session outside any transaction"
Level: medium
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:433"
Auditor: "pilcrow"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# PIL-004 — SQL issue(supersedes) deletes the old session outside any transaction

`MEDIUM` · `correctness` · `core` · reported by **pilcrow (pilcrowOnPaper) — Creator of Lucia Auth** (`pilcrow`)

Status: **resolved**

## Summary

The repository header states each repository never opens its own transaction and 'the calling domain service holds that boundary', but Sessions.layerSql's issue performs repo.delete(supersedes) and repo.insert as two independent statements with no sqlTransaction wrapper — unlike OAuth's callback, which does wrap its account-link step. If the process dies or the insert fails after the delete commits, the caller's prior session is already gone and no new session exists: a lockout window exactly where the fixations-rotation invariant (BEH-EA-053: issue and supersede 'in the same call') demands atomicity. The memory layer is atomic (one Ref.update), so the two Layers silently diverge in their guarantees.

## Evidence

Source: `packages/core/src/Sessions.ts:433`

```
if (input.supersedes !== undefined) {
  yield* repo.delete(input.supersedes).pipe(Effect.orDie);
}
```

## Recommended fix

Wrap delete + insert in sqlTransaction.withTransaction inside layerSql's issue (or invert: insert first, then delete, so failure leaves two live sessions rather than zero); document the guarantee on SessionsShape so memory and SQL stay honestly equivalent.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: session fundamentals
- Full dossier: [`pilcrow`](../../.reports/pilcrow/index.html) · Board: [`dashboard`](../../.reports/index.html)
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
