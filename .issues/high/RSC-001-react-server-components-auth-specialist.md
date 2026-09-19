---
ID: "RSC-001"
Title: "Memory-layer SessionView carries secretHash at runtime despite the type contract forbidding it"
Level: high
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:217"
Auditor: "react-server-components-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RSC-001 — Memory-layer SessionView carries secretHash at runtime despite the type contract forbidding it

`HIGH` · `security` · `core` · reported by **React Server Components Auth Specialist** (`react-server-components-auth-specialist`)

Status: **resolved**

## Summary

SessionRow has secretHash (line 207) and toView returns the row object by identity, so every SessionView produced by the memory layer's issue/verify actually carries secretHash at runtime; TypeScript accepts it because a variable reference is exempt from excess-property checks. The interface doc (line 89) promises "never the secret, never the stored hash". Downstream, packages/next's getSession exposes session: Sessions.SessionView to RSC code — one careless prop pass to a Client Component serializes the stored hash into the flight payload, exactly the boundary this persona polices. The SQL layer's toSessionView (line 402) builds an explicit object and is immune; the memory layer (what tests and examples/memory-server use) is not. Mitigating: hashSecret is SHA-256 of a 32-random-byte secret (line 39), so the leak is not directly reversible today — but the type lies, and any future weakening of the hash turns this latent leak into session hijacking.

## Evidence

Source: `packages/core/src/Sessions.ts:217`

```
const toView = (row: SessionRow): SessionView => row;
```

## Recommended fix

Make toView construct an explicit view object (same fields as toSessionView) so the runtime shape matches the declared type, and add a regression test asserting "secretHash" in (yield* Sessions.issue(...)).session === false for both layers.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: RSC auth boundary
- Full dossier: [`react-server-components-auth-specialist`](../../.reports/react-server-components-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — Sessions.ts:217 `const toView = (row: SessionRow): SessionView => row` returns the row by identity (`SessionRow.secretHash` at line 207), so the memory layer's `SessionView` carries `secretHash` at runtime despite the doc comment at line 89; the SQL layer's `toSessionView` (line 402) already builds an explicit object correctly, giving a direct fix pattern to mirror. Status → ready-for-agent.

**Resolved (2026-09-19):** `toView` (`packages/core/src/Sessions.ts`) now builds an explicit object naming only `SessionView`'s own 9 fields, mirroring `toSessionView`'s existing pattern exactly — `secretHash` and RRS-003's own newer internal fields (`familyId`, `supersededBy`, `supersededAt`, `reusedAt`) no longer leak through by identity.

TDD: added "issue/verify never expose secretHash or other internal row fields" to `packages/core/test/Sessions.test.ts`, run against both `layerMemory` and `layerSql` via the file's existing `suite` helper — asserts `Object.keys(session)` (and the post-`verify` view) equals exactly `SessionView`'s declared key set (not just `notProperty("secretHash", ...)`, so any other internal field leaking the same way is caught too). Verified to genuinely fail with the fix reverted: the diff showed exactly `secretHash`, `familyId`, `supersededAt`, `supersededBy`, and `reusedAt` all present on the returned view. Full monorepo `pnpm run typecheck` and `pnpm run test` both green (664 passed, 7 skipped).
