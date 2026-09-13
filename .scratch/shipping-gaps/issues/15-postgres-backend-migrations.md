# 15 — Real Postgres backend: driver + migrator + contract suite passing against it

**What to build:** effect-auth can run against a real, migrated Postgres
database, proven by the existing repository contract-test kit passing a
third time (alongside memory and SQLite) against a live Postgres instance
in CI.

**Blocked by:** None — can start immediately

**Status:** done

## Result

`@effect/sql-pg` added to the catalog + `packages/sql`'s devDependencies.
New `packages/sql/src/CoreMigrations.ts`: `coreMigrations`, a real
`Migrator.Loader` for the core tables (users/accounts/sessions/
verification_tokens/verification_reservations + the partial unique
index), branching per dialect via `sql.onDialectOrElse` — one definition,
not two duplicated schema files. `packages/sql/test/Repositories.test.ts`
now runs the real framework `Migrator` against SQLite (replacing its own
hand-rolled `CREATE TABLE` setup) — 14 tests, still green, now proving
the migration set itself, not just the repositories. A new
`Repositories.postgres.test.ts` runs the same repositories against a
real `@effect/sql-pg` connection, gated on `EFFECT_AUTH_POSTGRES_URL`
(skips, doesn't fail, when unset — no live Postgres was available in
this session's own environment to verify against directly). CI
(`check.yml`) now provisions a real `postgres:16` service and sets that
env var, so the gate is never silently skipped there — the exact failure
mode this map's own spec flagged in upstream's live-PG test.

Also wired `packages/core/src/Migrations.ts`'s scaffold onto the same
real `Migrator` (a `run(migrations)` adapter, tested with a real SQLite
DB in a new `Migrations.test.ts`) — this is the *plugin*-declared
migration list (`Auth.make`'s own aggregated `built.migrations`), a
separate mechanism from `CoreMigrations` since core's domain services
aren't themselves a plugin. No plugin populates `migrations` yet, so
this has no real caller today — proportionate for a first real wiring
of an existing scaffold, not new dead infrastructure.

**Real TS bug found and fixed along the way**: `Migrator`'s own
`loadMigration` reads `.default`/`Effect.isEffect` off whatever a
`ResolvedMigration`'s `load` field *resolves to*, not off `load` itself
— a migration's `load` must be `Effect.succeed(migrationBodyEffect)`,
not the body effect directly. Got this wrong on the first pass (a
`TypeError: Cannot read properties of undefined (reading 'default')`
against real SQLite caught it immediately); documented in both
`CoreMigrations.ts` and `core/Migrations.ts` for whoever writes the next
one.

**Not built here (deliberately, scope cut):** plugin-specific tables for
`Organization`/`Admin`/`Passkey`/`Jwt` — each owns its own SQL schema in
its own package, none of it audited or migrated to Postgres in this
ticket; multiplying this ticket's scope by 5 for gaps the origin report
never named. `packages/sql` stays dialect-agnostic in principle (per
this map's own ticket 03 decision) with Postgres now a second real,
tested backend alongside SQLite.

`pnpm test` — 573 passed, 2 gracefully skipped (the Postgres suite, no
local DB); `pnpm typecheck`/`pnpm lint`/`pnpm format:check` clean
workspace-wide. CI's own Postgres run is unverified from this session
(no local Docker daemon available either) — first real signal comes from
the next CI run.

- [ ] A real `PgClient`-backed `SqlClient` layer is available for
      `packages/sql`'s repositories, alongside the existing
      memory/SQLite layers — the SQLite path is unchanged and unregressed
- [ ] The existing `packages/core/src/Migrations.ts` scaffold is wired
      onto Effect's own real `Migrator` (file-based, forward-only,
      tracked in a dedicated migrations table, the whole pending batch
      applied inside one transaction)
- [ ] A committed migration set brings a fresh Postgres database to
      schema-equality with what `Models.ts` declares; a dedicated test
      asserts that equality
- [ ] The existing dual-backend (memory/SQLite) repository
      contract-test suite (`runPluginContractTests`) runs a third time
      against the real Postgres layer — same test bodies, one more
      backend
- [ ] CI provisions a real Postgres service and runs this suite against
      it, mirroring how other plugin suites already run in CI
