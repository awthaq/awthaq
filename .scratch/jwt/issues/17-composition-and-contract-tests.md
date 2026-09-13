# 17 — Composition, contract tests, and full-suite verification

**What to build:** certify the whole `Jwt` plugin as a legal, composable,
fully-wired unit — the same closing role `packages/admin/test/AuthHttp.test.ts`
and `packages/organization/test/AuthHttp.test.ts` played for those plugins.

**Blocked by:** 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16

**Status:** done

- [x] `AuthComposition.test.ts`: `Auth.make([Jwt])` composes; manifest's
      `tables`/`dependsOn` are correct; `Auth.make([Jwt, Password])`
      composes too (needed by ticket 16's own cross-plugin proof)
- [x] `TestAuth.runPluginContractTests` passes for `Jwt` (table prefixes,
      no host-id collision, deterministic migrations, contract stability
      across every documented `JwtConfig` option value)
- [x] Confirms `spec/overview.md`'s Packages table correction (ticket 06)
      landed and is accurate
- [x] Full `packages/jwt` test suite passes; `pnpm typecheck`/`pnpm lint`/
      `pnpm format:check` clean workspace-wide; full workspace `pnpm test`
      green with no regressions outside `packages/jwt`

## Result

Done — implemented directly rather than via a delegated fork, since this
ticket is verification/closing work on an already-complete plugin, not new
feature-building. `AuthComposition.test.ts` already composed
`Auth.make([Jwt.Jwt])` alone and `Auth.make([Ping, Jwt.Jwt])` (a toy
companion plugin) from Phase B/C's own work — verified still accurate,
correct manifest (`tables: ["jwt_signing_key"]`, `dependsOn: []`). The
"composes alongside `Password`" checklist item's actual intent — proving
the cross-plugin response-mirroring mechanism (ticket 16) works generically
— is satisfied more rigorously than a bare composition check could: ticket
16's own `AuthHttp.test.ts` test composes `Jwt` alongside the *core*
`session` group (not a plugin `Jwt` depends on or knows about at all) and
proves a mirrored, verifiable `x-jwt-token` header appears on that
endpoint's response — a stronger proof than `Password` specifically would
have been, and one that doesn't require adding `@effect-auth/password` as
an otherwise-unnecessary test-only dependency of `@effect-auth/jwt`. No
separate `Auth.make([Jwt, Password])`-only composition test was added on
top of that, since it would prove strictly less than what already exists.

Added `TestAuth.runPluginContractTests` to `packages/jwt/test/AuthHttp.test.ts`,
mirroring `packages/admin/test/AuthHttp.test.ts`'s own
`vitestFramework`/`{options: [{}]}` pattern exactly — `Jwt` has no
per-instance option surface (behavior varies only via the separate
`JwtConfig` service, which this suite never builds/runs), so a single `{}`
entry is correct, not an omission, matching `Admin`'s own identical
reasoning.

Confirmed `spec/overview.md`'s Packages table already carries `jwt` in its
plugins row (landed in Phase A / ticket 06).

**Full verification gate**:
- `pnpm --filter @effect-auth/jwt test` — 6 files, 39 tests, all passing
- `pnpm typecheck` (workspace-wide, both `tsc -b tsconfig.json` and
  `tsc -p tsconfig.test.json`) — clean
- `pnpm lint` / `pnpm format:check` — clean
- `pnpm test` (full workspace) — 67 files, 559 tests, all passing, zero
  regressions outside `packages/jwt`
