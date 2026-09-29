---
ID: "RRC-006"
Title: "CAS touch loser returns a session view the presented token can no longer verify"
Level: medium
Category: "correctness"
Status: needs-triage
Package: "core"
Source: "packages/core/src/Sessions.ts:544"
Auditor: "read-replica-consistency-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRC-006 — CAS touch loser returns a session view the presented token can no longer verify

`MEDIUM` · `correctness` · `core` · reported by **Read Replica Consistency Specialist** (`read-replica-consistency-specialist`)

Status: **needs-triage**

## Summary

When a concurrent request wins the throttled rotation, the loser re-reads the row and returns the fresh view with rotated: Option.none() — so its caller keeps the just-presented token, whose secretHash the winner has already overwritten. The response succeeds but the credential is dead: the user's next request fails SessionNotFound and is forced to re-login. Within-request memoization (Authentication.ts resolveSession) hides this only for the remainder of the same request. This is the single-primary seed of the same staleness class as RRC-005 — a read-your-write gap at the service boundary — and under lagging reads the loser's re-read may not even observe the winner's write, returning a view that matches neither the old nor the new credential state.

## Evidence

Source: `packages/core/src/Sessions.ts:544`

```
        return { session: toSessionView(current), rotated: Option.none() };
```

## Recommended fix

On CAS loss, let the loser retry the rotation once from the current row's hash (expectedSecretHash = the re-read value) and return its own rotated token, preserving read-your-write for the losing client instead of stranding it on a dead credential.

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

**Plan validation (2026-09-29):** INVALID (confidence medium); workstream `read-replica-routing`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:838`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/01-core-sessions-users.md`.
