---
ID: "RRC-005"
Title: "Newly issued or rotated session tokens can be rejected by the very next request under replica-served reads (false 401)"
Level: medium
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:548"
Auditor: "read-replica-consistency-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRC-005 — Newly issued or rotated session tokens can be rejected by the very next request under replica-served reads (false 401)

`MEDIUM` · `correctness` · `core` · reported by **Read Replica Consistency Specialist** (`read-replica-consistency-specialist`)

Status: **resolved**

## Summary

The rotated token is handed to the client in this response (server deliverRotation; password signUp sets the issued cookie directly at Password.ts:273-275), but the next request's verify re-reads the row via repo.findById (line 474). If that read lands on a replica that has not yet applied this request's INSERT (fresh login) or hash-rotation UPDATE, the brand-new credential fails the constant-time comparison and maps to SessionNotFound — a 401 on the request immediately following a successful login, exactly the failure class this design must prevent. The hourly touchEvery throttle (Sessions.ts:74) means every active session crosses this write-then-read handoff at least once per hour, so the window is routinely exercised, not an edge case.

## Evidence

Source: `packages/core/src/Sessions.ts:548`

```
        session: toSessionView(touched.value),
        rotated: Option.some(Redacted.make(`${id}.${newSecret}`)),
```

## Recommended fix

Guarantee session-credential reads are causally consistent with the issuing/rotating write (primary pinning or LSN gating) before any replica routing is offered; add a regression test that replays the new token against an artificially lagged read.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: replica consistency
- Full dossier: [`read-replica-consistency-specialist`](../../.reports/read-replica-consistency-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence medium); workstream `read-replica-routing`. Duplicate of `RRC-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:849`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `RRC-001-read-replica-consistency-specialist` — closed by its fix (see that issue's Resolved comment).
