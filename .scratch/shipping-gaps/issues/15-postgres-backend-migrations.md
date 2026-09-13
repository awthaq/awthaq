# 15 — Real Postgres backend: driver + migrator + contract suite passing against it

**What to build:** effect-auth can run against a real, migrated Postgres
database, proven by the existing repository contract-test kit passing a
third time (alongside memory and SQLite) against a live Postgres instance
in CI.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

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
