---
"@awthaq/core": minor
"@awthaq/cli": patch
---

`Migrations.status`, `apply`, `verify` and `onBuild` run core's and the composition's migrations with the ledger-drift refusal `awthaq migration apply` already had (BEH-EA-204, BEH-EA-039); new errors `Migrations/LedgerDrift`, `Migrations/Pending`, `Migrations/MigrationFailed`. `apply` calls no `Migrator` when nothing is pending; `verify` applies nothing and refuses a pending migration. The CLI now reads and writes the ledgers through them; its output and exit codes are unchanged.

Migration: code that ran `Migrator.make({})({ loader: CoreMigrations.coreMigrations })` and then `Migrations.run(auth.migrations)` at boot should call `Migrations.apply(auth.migrations)` (or let `AuthHost` do it): the two-step form silently skips a plugin migration that sorts before an applied one. `Migration.inspect`, `diff`, `tableExists`, `pluginKnown`, `coreLedgerTable` and `pluginLedgerTable` are no longer exported from `@awthaq/cli`'s `Migration` module; use `Migrations.status`, `diff`, `tableExists`, `pluginKnown` and `coreMigrationsTable`/`pluginMigrationsTable` from `@awthaq/core`.
