---
ID: "TRBS-006"
Title: "Expired sessions are never evicted in either layer; the store grows unbounded"
Level: medium
Category: "performance"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:278"
Auditor: "token-revocation-blacklist-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TRBS-006 — Expired sessions are never evicted in either layer; the store grows unbounded

`MEDIUM` · `performance` · `core` · reported by **Token Revocation & Blacklist Specialist** (`token-revocation-blacklist-specialist`)

Status: **resolved**

## Summary

Expiry is enforced as a read-time check that returns SessionExpired without removing the row — the only single-row removals are explicit revoke, supersedes, and (SQL) the bulk deletes. In layerMemory the HashMap therefore accumulates every session ever issued until process restart, and in layerSql the sessions table grows forever with no periodic `DELETE WHERE absoluteExpiresAt < now` anywhere in packages/sql. This is the persona red flag 'an unbounded store with no expiry-based eviction' applied to the allowlist: a positive-list store should self-prune on the same deadline that kills the credential. It also compounds TRBS-004 — dead rows crowd verifyLive's 200-row page.

## Evidence

Source: `packages/core/src/Sessions.ts:278`

```
if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.value.absoluteExpiresAt)) {
        return yield* Effect.fail(
          new SessionExpired({ message: `awthaq: session expired: ${id}`, id }),
```

## Recommended fix

In layerMemory, delete the row on the expired branch of verify (it is already past both deadlines and unrevivable). In layerSql, add a scheduled sweep (or lazy delete on the expired read path) removing rows past absoluteExpiresAt; both keep revocation semantics unchanged since deletion and expiry-denial are indistinguishable to callers (both map to SessionExpired/SessionNotFound at verify).

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Token Revocation
- Full dossier: [`token-revocation-blacklist-specialist`](../../.reports/token-revocation-blacklist-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `data-retention-sweep`. Duplicate of `CSG-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:786`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.
