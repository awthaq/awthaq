---
ID: "DRS-004"
Title: "Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning"
Level: medium
Category: "architecture"
Status: needs-triage
Package: "core"
Source: "packages/core/src/Sessions.ts:474"
Auditor: "data-residency-sharding-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DRS-004 — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning

`MEDIUM` · `architecture` · `core` · reported by **Data Residency & Sharding Specialist** (`data-residency-sharding-specialist`)

Status: **needs-triage**

## Summary

The token is '<uuidv7>.<64-hex-secret>' (id and secret minted at Sessions.ts:230-232, parsed at :269-270): time-ordered, cryptographically random, and location-blind. layerSql verify resolves it with repo.findById(id) (:474) — the cheapest possible hot-path query, but one that presupposes the row is findable in the one ambient database. Under hash-sharding by sessionId it routes trivially, yet the user-colocated flows the same repository exposes (listByUser, deleteAllByUser/Except, Repositories.ts:383-448) assume all of a user's sessions share one shard — the two schemes are mutually exclusive and the code commits to neither. This is exactly the 'global directory hit on every authenticated request' trap the persona rubric flags.

## Evidence

Source: `packages/core/src/Sessions.ts:474`

```
const row = yield* repo.findById(id).pipe(
```

## Recommended fix

Pick the contract now: either shard by userId (token gains a region hint derived from the user's home region, e.g. a prefix segment) and accept per-user colocation, or shard by sessionId hash and re-specify revokeAll/list as per-shard scatter-gather in SessionsShape. Encode the choice in spec/decisions before any SQL deployment scales.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: data residency readiness
- Full dossier: [`data-residency-sharding-specialist`](../../.reports/data-residency-sharding-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Redundant assertion after sound narrowing in session supersedes path](low/AH-007-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`AGA-004` — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate](medium/AGA-004-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BO-005` — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login](medium/BO-005-balazs-orban.md) `_(balazs-orban, medium)_`
- [`BAM-003` — Session cutover invalidates every live better-auth session with no bridge](high/BAM-003-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`ECF-007` — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard](low/ECF-007-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-008` — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim](low/EEM-008-effect-error-management-specialist.md) `_(effect-error-management-specialist, low)_`
- [`EOTS-004` — Session ids — the public half of a bearer credential — are interpolated into error messages that reach logs](medium/EOTS-004-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence medium); workstream `read-replica-routing`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:747`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/01-core-sessions-users.md`.
