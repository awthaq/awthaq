---
ID: "MA-004"
Title: "Environmental failures (SqlError, SchemaError, PlatformError) are systematically routed to the defect channel"
Level: medium
Category: "architecture"
Status: ready-for-human
Package: "core"
Source: "packages/core/src/Sessions.ts:478"
Auditor: "michael-arnaldi"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MA-004 — Environmental failures (SqlError, SchemaError, PlatformError) are systematically routed to the defect channel

`MEDIUM` · `architecture` · `core` · reported by **Michael Arnaldi — Creator of Effect** (`michael-arnaldi`)

Status: **ready-for-human**

## Summary

Every layerSql maps SqlError and SchemaError to die (Sessions.ts:478-479, Users.ts, Verification.ts), and plugins follow suit (Password.ts:483 dies PlatformError) — 272 orDie/die sites total against 35 typed error classes. The codebase's stated rationale (Users.ts layerSql header: a dropped connection 'is a genuine defect, not a domain error') conflates two things Effect deliberately separates: a broken invariant (die) and an environmental failure (typed error or defect-with-recovery-at-runtime). A transient pool exhaustion, deadlock, or serialization failure during Sessions.verify becomes an uncatchable defect — no typed retry, no fallback store, upstream must catchCause and guess. Worse, the declared contracts are already inconsistent with the implementations: SessionsShape's error channel declares PlatformError.PlatformError, yet layerSql's actual failure mode (SqlError) is died, so the shape's E parameter is neither complete nor authoritative — it documents what layerMemory does, not what the service can fail with.

## Evidence

Source: `packages/core/src/Sessions.ts:478`

```
          SchemaError: Effect.die,
          SqlError: Effect.die,
```

## Recommended fix

Define the taxonomy explicitly: keep die for the genuinely-unreachable invariant violations (LinkerInvariantViolation is the model), but put a tagged InfraError (or SqlError itself) into the service channels, or document a project-wide policy that operational failures are defects recovered at the runtime boundary — and then make the declared E in *Shape interfaces match that policy instead of drifting per implementation.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Effect v4 architecture
- Full dossier: [`michael-arnaldi`](../../.reports/michael-arnaldi/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `core-error-taxonomy`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:747`. Fix: Adopt one infrastructure-error policy across core Shapes (recommended: typed StoreUnavailable), recorded as an ADR, and make every Shape's E channel authoritative for both layers. (effort XL). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-human.

**Decision (2026-09-29):** adopted recommended option B per plan (typed `StoreUnavailable`); user may revisit. Recorded as ADR-EA-028.

**Plan note (2026-09-29):** landed for Sessions, Verification, Accounts and Users (E channels, layerSql seams, layerMemory crypto PlatformError -> StoreUnavailable, `Errors.storeUnavailable`/`orStoreUnavailable`, the Authentication/Optional/Admin/Csrf middleware declaring it so an outage answers 503 with a request-scoped outage record so the security chain's fall-through cannot turn it back into 401, qadi's extractor mapping it to SubjectExtractionFailed, the nine `catchTag("PlatformError", Effect.die)` bridges removed). Tests: core Sessions/Verification/Accounts/Users infrastructure-failure suites, server Authentication 503. **Still open:** `AuditLog` (P10 owns it; its `record` path still `orDie`s SqlError and the crypto PlatformError), the per-endpoint 503 mention in features/03-http-layer/11-http-error-mapping.feature (feature is skipped and unwired), and the Schedule-based retry helper for SQLITE_BUSY (SEA-002). Status left ready-for-human until AuditLog follows the same helper.

