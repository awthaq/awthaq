---
ID: "AH-007"
Title: "Redundant assertion after sound narrowing in session supersedes path"
Level: low
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:228"
Auditor: "anders-hejlsberg"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-007 — Redundant assertion after sound narrowing in session supersedes path

`LOW` · `correctness` · `core` · reported by **Anders Hejlsberg — Creator/Lead Architect of TypeScript** (`anders-hejlsberg`)

Status: **resolved**

## Summary

Inside `if (input.supersedes !== undefined)` the optional property is already narrowed to SessionId, so the assertion adds nothing but a second instance of the `as` pattern the codebase claims to forbid — under exactOptionalPropertyTypes the check-and-use narrowing is sound without it. Harmless today, but every unnecessary assertion normalizes the pattern and erodes the enforceability of the no-as rule (see AH-004).

## Evidence

Source: `packages/core/src/Sessions.ts:228`

```
yield* Ref.update(state, (s) => HashMap.remove(s, input.supersedes as SessionId));
```

## Recommended fix

Delete the cast; if a future refactor breaks narrowing, prefer extracting `const supersedes = input.supersedes` before the guard so the narrowed const flows into the update.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 74/100), domain: Type system design
- Full dossier: [`anders-hejlsberg`](../../.reports/anders-hejlsberg/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AGA-004` — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate](medium/AGA-004-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BO-005` — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login](medium/BO-005-balazs-orban.md) `_(balazs-orban, medium)_`
- [`BAM-003` — Session cutover invalidates every live better-auth session with no bridge](high/BAM-003-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`DRS-004` — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning](medium/DRS-004-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ECF-007` — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard](low/ECF-007-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-008` — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim](low/EEM-008-effect-error-management-specialist.md) `_(effect-error-management-specialist, low)_`
- [`EOTS-004` — Session ids — the public half of a bearer credential — are interpolated into error messages that reach logs](medium/EOTS-004-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `session-supersede-atomicity`. Already fixed by commit 9017a8a. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:335`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.
