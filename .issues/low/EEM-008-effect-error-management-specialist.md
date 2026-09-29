---
ID: "EEM-008"
Title: "Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim"
Level: low
Category: "dx"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:113"
Auditor: "effect-error-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EEM-008 — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim

`LOW` · `dx` · `core` · reported by **Effect Typed Error Management Specialist** (`effect-error-management-specialist`)

Status: **resolved**

## Summary

Internal domain errors duplicate their structured context into a human-readable message string (SessionNotFound 'awthaq: no such session: ${id}', AccountNotFound, JwtInvalidError.reason, KeyGenerationError.cause: unknown) — fields that add nothing the _tag plus typed fields lack, but invite log dumps and, if one ever migrates to a wire contract, direct internal leak. Concurrently, five internal tags collide verbatim with wire-strata classes (SessionNotFound, TokenConsumed, EmailAlreadyExists, RateLimited, PasskeyCredentialNotFound exist in both Data- and Schema-flavored strata), so a handler mapping by tag string (catchTag('TokenConsumed', () => new PasswordApi.TokenConsumed())) relies on convention, not the type system, to keep the strata straight.

## Evidence

Source: `packages/core/src/Sessions.ts:113`

```
export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{
  readonly message: string;
}> {}
```

## Recommended fix

Prefer structured fields (ids, kid, reason enum) over message strings on internal errors, and consider namespacing internal tags (e.g. CoreSessionNotFound) or a shared phantom-brand so catchTag cannot accidentally bridge strata.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 77/100), domain: typed error discipline
- Full dossier: [`effect-error-management-specialist`](../../.reports/effect-error-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 35 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Redundant assertion after sound narrowing in session supersedes path](low/AH-007-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`AGA-004` — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate](medium/AGA-004-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BO-005` — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login](medium/BO-005-balazs-orban.md) `_(balazs-orban, medium)_`
- [`BAM-003` — Session cutover invalidates every live better-auth session with no bridge](high/BAM-003-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`DRS-004` — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning](medium/DRS-004-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ECF-007` — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard](low/ECF-007-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EOTS-004` — Session ids — the public half of a bearer credential — are interpolated into error messages that reach logs](medium/EOTS-004-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `core-error-taxonomy`. Duplicate of `ESS-008-effect-schema-specialist` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:142`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `ESS-008-effect-schema-specialist` — closed by its fix (see that issue's Resolved comment).
