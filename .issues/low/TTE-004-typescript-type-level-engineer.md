---
ID: "TTE-004"
Title: "Redundant branded cast `input.supersedes as SessionId` violates the zero-assertion rule for no benefit"
Level: low
Category: "compliance"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:228"
Auditor: "typescript-type-level-engineer"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TTE-004 — Redundant branded cast `input.supersedes as SessionId` violates the zero-assertion rule for no benefit

`LOW` · `compliance` · `core` · reported by **TypeScript Type-Level Engineer** (`typescript-type-level-engineer`)

Status: **resolved**

## Summary

`SessionsShape.issue` (line 140) already declares `supersedes?: SessionId`, and the implementation is annotated `SessionsShape["issue"]`, so after the `!== undefined` narrowing the value IS `SessionId` — the assertion is dead weight that also breaks the repo's own no-`as` rule. Its presence suggests the parameter annotation does not flow through `Effect.fnUntraced`'s contextual typing; that inference gap is worth knowing about rather than papering over per call site.

## Evidence

Source: `packages/core/src/Sessions.ts:228`

```
if (input.supersedes !== undefined) {
  yield* Ref.update(state, (s) => HashMap.remove(s, input.supersedes as SessionId));
}
```

## Recommended fix

Delete the cast; if compilation fails, the real fix is a locally typed `const superseded: SessionId = input.supersedes` after narrowing (surfacing the inference gap), not an assertion. Then add an oxlint `no-restricted-syntax` rule for `as`-assertions in src so the stated rule is mechanically enforced.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Type-Level Rigor
- Full dossier: [`typescript-type-level-engineer`](../../.reports/typescript-type-level-engineer/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `session-supersede-atomicity`. Already fixed by commit 9017a8a. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:335`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.
