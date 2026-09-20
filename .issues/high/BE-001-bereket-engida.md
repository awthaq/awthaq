---
ID: "BE-001"
Title: "None of the 11 plugin tables ships a migration; DDL exists only inside test setup"
Level: high
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/Migrations.ts:33"
Auditor: "bereket-engida"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BE-001 — None of the 11 plugin tables ships a migration; DDL exists only inside test setup

`HIGH` · `architecture` · `core` · reported by **Bereket Engida — Creator of better-auth** (`bereket-engida`)

Status: **resolved**

## Summary

The plugin contract carries `tables` and `migrations`, and Auth.make aggregates and dependency-orders plugin migrations (renumberMigrations), but no real plugin populates `migrations:` — only test fixtures with `up: Effect.void` do. The passkey (2), organization (7), admin (1), and jwt (1) tables are created solely by raw CREATE TABLE statements inside vitest setup (e.g. packages/admin/test/ImpersonationRecords.test.ts:26, packages/passkey/test/PasskeyCredentials.test.ts:23); only the 5 core tables have real dual-dialect DDL (packages/sql/src/CoreMigrations.ts). Any production SQL deployment of Passkey, Organization, Admin, or Jwt cannot create its schema. better-auth solved exactly this with adapter-level schema generation; effect-auth has the aggregation plumbing but no producer.

## Evidence

Source: `packages/core/src/Migrations.ts:33`

```
 * so this has no real caller today — proportionate for a first wiring,
 * not dead weight: a plugin author adding `migrations: [...]` to their
 * own `AuthPlugin.Service` options gets a real, tested runner for free.
```

## Recommended fix

Ship each plugin's DDL as `migrations:` on its own AuthPlugin.Service — the runner, ordering, and renumbering already exist — following CoreMigrations.ts's onDialectOrElse dual-dialect pattern; verify with a composition test that Auth.make plugins yields a complete migration list.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: plugin architecture parity
- Full dossier: [`bereket-engida`](../../.reports/bereket-engida/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`DRS-003` — Zero production migrations exist for all 11 plugin-owned tables — no surface on which residency partitioning could ship](high/DRS-003-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/core/src/Migrations.ts:23-33` states "no plugin populates `migrations` yet... so this has no real caller today"; `grep -rn "migrations:" packages/{passkey,organization,admin,jwt}/src` returns nothing, while `packages/admin/test/ImpersonationRecords.test.ts:26` and `packages/passkey/test/PasskeyCredentials.test.ts:23` hand-write raw `CREATE TABLE` statements in test setup. Only `packages/sql/src/CoreMigrations.ts` ships real dual-dialect DDL. The fix follows that file's existing pattern per plugin, so it is mechanical rather than requiring new architecture. Status → ready-for-agent.

**Resolved (2026-09-20):** Both halves of this finding's recommended fix turned out to already be substantially in place from independent, earlier-resolved findings in this same tracker — this session's own job was to verify that genuinely, close the one real gap it found, and correct what the fix left stale:

- "Ship each plugin's DDL as `migrations:`" — already done: `BAM-002` (.issues/high) shipped dual-dialect `migrations:` for admin (1 table), organization (7 tables), and passkey (2 tables); a separate, earlier `TIR-001`/`SSMS-001` pass (predating this tracker's own current sweep) shipped it for jwt (`jwt_signing_key`, `jwt_token_revocation`); `BAM-006` shipped it for roles (`role_assignments`). `oauth`/`password` deliberately keep `tables: []` (each plugin's own header comment explains why — no table to migrate). Verified with `grep -rn "migrations:" packages/*/src/*.ts`: every plugin owning a table now populates it; zero remain like the finding's own evidence quoted.
- "verify with a composition test that Auth.make plugins yields a complete migration list" — already existed and already does exactly this: `packages/core/test/AuthPlugin.test.ts`'s `Auth.make` suite (`"composes api, layer, migrations, and manifest from one plugin tuple"`) composes two synthetic plugins (`Ping`, with a `dependsOn`-free migration, and `Pong`, which depends on `Ping` and carries its own) and asserts `auth.migrations.map((m) => m.name)` equals the fully renumbered, dependency-ordered list. Mutation-verified it's a real guard, not a stale assertion: temporarily dropped `renumberMigrations`'s first plugin (`order.slice(1)`) in `packages/core/src/Auth.ts` — this exact test failed with the correct diff (missing the `0001_ping_...` entry); reverted.
- Found and closed the one genuine remaining instance of this finding's own complaint: `packages/jwt/test/KeyRing.test.ts` still hand-rolled its own inline `CREATE TABLE jwt_signing_key (...)` fixture — `Jwt.ts`'s own `jwtMigrations` doc comment already named this file as a "pre-existing gap this closes in passing" that never actually got converted, unlike its sibling `RevocationStore.test.ts` (already migrated in the same earlier pass). Converted it to `Layer.effectDiscard(Migrations.run(Jwt.Jwt.migrations))`, the identical pattern `RevocationStore.test.ts` already uses, dropping the now-redundant hand-rolled SQL and its direct `SqlClient` import. Mutation-verified: temporarily dropped `retiresAt` from `jwtMigrations`'s sqlite `CREATE TABLE jwt_signing_key` branch in `packages/jwt/src/Jwt.ts` — 3 `KeyRing.test.ts` tests genuinely failed with a real `SQLITE_ERROR`; reverted.
- Corrected `packages/core/src/Migrations.ts`'s own doc comment, which this finding's own Evidence quoted verbatim ("no plugin populates `migrations` yet... so this has no real caller today") — now stale and misleading given the above. The corrected comment states plainly which plugins populate `migrations` now, still names the one thing that remains genuinely true (`Migrations.run` itself has zero PRODUCTION call sites — only test suites invoke it), and explains why: `Auth.make` doesn't yet prepend `AuthCore`'s own migrations (that plugin doesn't exist until M1 Core, per `Auth.ts`'s own module header), so there is nowhere in a real deployment for the aggregated list to be consumed yet. Wiring that real bootstrap caller is a distinct, larger concern (deployment/CLI tooling) this finding's own Evidence and Recommended fix never asked for, and is left open.

Full monorepo `pnpm run typecheck` clean; `pnpm run test` green (744 passed, unchanged — this fix only converts one test fixture and two doc comments, no behavior changed for any passing path). `test:bdd` not run — no BDD-relevant file touched. `npx oxfmt` run on all 4 touched files; re-verified typecheck and the `jwt`/`core` package suites green after formatting.
