---
ID: "SMS-007"
Title: "verify short-circuits on unknown id before hashing — a session-id existence oracle by timing"
Level: info
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:272"
Auditor: "session-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SMS-007 — verify short-circuits on unknown id before hashing — a session-id existence oracle by timing

`INFO` · `security` · `core` · reported by **Session Management Specialist** (`session-management-specialist`)

Status: **resolved**

## Summary

verify resolves the row (memory line 271, SQL repo.findById line 474) and checks both expiries before any hashing happens, so 'unknown id' and 'known id, wrong secret' take observably different code paths and work profiles. The split is well mitigated — the id half is a UUIDv7 with ~74 random bits (crypto.randomUUIDv7, line 230; Model.UuidV7Insert in the SQL layer) and the credential that matters is a 256-bit secret — so remote exploitation is unrealistic; recorded as an observation for completeness since the codebase otherwise goes out of its way for uniform-cost paths (the password plugin's dummy-hash pattern).

## Evidence

Source: `packages/core/src/Sessions.ts:272`

```
const row = yield* Ref.get(state).pipe(Effect.map((s) => HashMap.get(s, id)));
      if (Option.isNone(row)) {
        return yield* Effect.fail(
```

## Recommended fix

If uniformity is ever desired, hash the presented secret before the lookup and compare after fetch; otherwise document the accepted asymmetry next to constantTimeEqual so future auditors know it was considered.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: session lifecycle
- Full dossier: [`session-management-specialist`](../../.reports/session-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `session-verify-hardening`. Duplicate of `PIL-007` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:423`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.
