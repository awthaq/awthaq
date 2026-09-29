---
ID: "RRC-004"
Title: "\"Old secret stops verifying immediately — no grace window\" holds only on a single primary; rotation and revocation degrade silently under lagging reads"
Level: medium
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:160"
Auditor: "read-replica-consistency-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRC-004 — "Old secret stops verifying immediately — no grace window" holds only on a single primary; rotation and revocation degrade silently under lagging reads

`MEDIUM` · `correctness` · `core` · reported by **Read Replica Consistency Specialist** (`read-replica-consistency-specialist`)

Status: **resolved**

## Summary

The throttled touch's CAS does overwrite the hash in one statement, which makes rotation immediate on the primary — but Sessions.verify validates tokens against repo.findById (line 474), a plain read with no affinity to that write. Any read path served by a lagging replica still holds the pre-rotation secretHash, so an old — possibly stolen — token keeps authenticating for the replication-lag duration, silently converting the documented no-grace-window property into a lag-sized grace window. The same applies to revoke, revokeOthers, and revokeAll (lines 552-567): DELETEs followed by replica reads resurrect revoked sessions. The claim is stated unconditionally, with no note of the topology it assumes.

## Evidence

Source: `packages/core/src/Sessions.ts:160`

```
 * secret's hash is overwritten in the same atomic write, so it stops
 * verifying immediately — no grace window. A concurrent second `verify`
```

## Recommended fix

Document the single-primary assumption next to the no-grace-window claim; when read splitting arrives, pin session-credential validation reads to the primary or gate them on the rotation/revocation write's LSN.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence medium); workstream `read-replica-routing`. Duplicate of `RRC-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:191`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.
