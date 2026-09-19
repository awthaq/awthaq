---
ID: "RRS-003"
Title: "Supersession is a hard delete — no reuse detection, no lineage, no token families"
Level: high
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:433"
Auditor: "refresh-token-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRS-003 — Supersession is a hard delete — no reuse detection, no lineage, no token families

`HIGH` · `security` · `core` · reported by **Refresh Token Rotation Specialist** (`refresh-token-rotation-specialist`)

Status: **resolved**

## Summary

Superseding a session hard-deletes the prior row (identically in layerMemory, Sessions.ts:227-229). A replayed superseded token therefore hits the generic "no such session" path (Sessions.ts:476-477) and is indistinguishable from a malformed or never-issued token — the evidence a reuse detector needs is destroyed at supersession time. The Session schema (packages/sql/src/Models.ts:108-129) has no parent/supersededBy/lineage column, and the AuthEvents registry has no session tags, so there is no theft signal, no family key, and no ability to revoke descendants of a compromised root: the family-wide-revocation control this domain exists to provide is absent. The compare-and-swap secret rotation is real but protects a single session in place; it is not token-family rotation, and a stolen pre-rotation secret can be silently absent (client rotated) or silently resurrected (nothing watches) with no observable difference.

## Evidence

Source: `packages/core/src/Sessions.ts:433`

```
if (input.supersedes !== undefined) {
        yield* repo.delete(input.supersedes).pipe(Effect.orDie);
      }
```

## Recommended fix

Replace the hard delete with a tombstone write (supersededBy, supersededAt, reusedAt columns); on presentation of a tombstoned session, fail externally with the same uniform SessionNotFound but internally publish auth.session.reuse and revoke the whole family (all rows sharing the root's lineage id).

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: Refresh & Token Rotation
- Full dossier: [`refresh-token-rotation-specialist`](../../.reports/refresh-token-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Decision (2026-09-19):** Resolved via [Token lifecycle store: revocation denylist, introspection endpoint, refresh-token reuse detection & families](../../.scratch/resolve-ready-for-human-findings/issues/11-token-lifecycle-store.md) — `Session` gains `familyId`/`supersededBy`/`supersededAt`/`reusedAt` columns; `issue`'s `supersedes` path tombstones instead of hard-deleting; first reuse of a tombstoned row publishes `auth.session.reuse` and revokes the whole family; `Sessions.list` filters out tombstoned rows so `verifyLive`/`introspectLive` see the revocation for free. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — Sessions.ts:433 (SQL layer) and :228 (memory layer) hard-delete the superseded row via `repo.delete`/`HashMap.remove` with no tombstone; Models.ts:98-127's `Session` model has no parent/supersededBy/lineage column, and AuthEvents.ts's closed `_tag` union has no session-reuse/theft tag. Fixing this requires new schema (lineage columns) and event-model design, not a mechanical patch. Status → ready-for-human.

**Resolved (2026-09-19):** Implemented per the decision ticket, exactly as scoped. `Session` model (`packages/sql/src/Models.ts`) gains four columns: `familyId` (this row's own id when it founds a family, inherited from the superseded row otherwise), `supersededBy`/`supersededAt` (nullable, set at most once), `reusedAt` (nullable, set at most once). New migration (`packages/sql/src/CoreMigrations.ts`, `add_sessions_reuse_detection_columns` + a `familyId` index) — identical shape added to `layerMemory`'s own `SessionRow`.

`Sessions.issue`'s `supersedes` path now tombstones the prior row (`repo.tombstone`/an in-place `HashMap` update) instead of hard-deleting it, and the new row inherits its `familyId`. `Sessions.verify` detects a tombstoned row on presentation: the *first* such presentation publishes a new `auth.session.reuse` event (`AuthEvents.ts`) and bulk-revokes (hard-deletes) every still-live row sharing `familyId` (new repository method `revokeFamily`); every presentation — first or repeated — gets the uniform external `SessionNotFound`, no distinguishable signal leaked. `Sessions.list` (both layers) now filters out tombstoned rows, which is what makes `verifyLive`/`Jwt.introspectLive` correctly reject a revoked family's JWTs for free, with no separate wiring. Explicit `revoke`/`revokeOthers`/`revokeAll` are unchanged — hard deletes, exactly as scoped (tombstoning applies only to the `supersedes` rotation path).

`Sessions.layerMemory`/`layerSql` both gained `AuthEvents.AuthEvents` as a new, mandatory `R` (previously neither needed it) — every composition site across the monorepo (~20 test files, `packages/test/src/TestAuth.ts`'s shared `MemoryPorts`) was updated to provide it alongside `Sessions.layerMemory`/`layerSql`, an accepted breaking change per this effort's standing directive.

TDD: full contract suite (`packages/core/test/Sessions.test.ts`) runs against both `layerMemory` and `layerSql`; new `reuseSuite` tests build a 3-generation family (A -> B -> C), present A's already-tombstoned token again, and assert C (the only live member) gets revoked, exactly one `auth.session.reuse` event is published (not two, on a repeated presentation), and `Sessions.list` excludes a tombstoned row. Verified via a genuine mutation test (stubbed the reuse branch to a bare `SessionNotFound` with no revocation/publish) that correctly failed the new tests before being reverted. Full monorepo `pnpm run typecheck` and `pnpm run test` both green (645 tests). Closes this finding and completes the decision ticket alongside TIR-001/TRBS-001/MAPS-002 (resolved separately, same ticket, jwt package).
