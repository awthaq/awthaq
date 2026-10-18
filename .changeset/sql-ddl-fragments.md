---
"@awthaq/sql": minor
"@awthaq/core": minor
---

`SqlDdl` renders the dialect-specific DDL tokens (`timestamp`, `boolean`, `int64`, `autoIncrementKey`, `nowTimestamp`) as fragments and builds `IF NOT EXISTS` indexes; `Migrations.group`/`Migrations.ledger` declare a records module's migrations beside its codec and compose a plugin's ledger, checked at compile time (ADR-EA-004 rev 1.3, BEH-EA-037). `Models.dialectFields` gains `int64`. `Auth.make` refuses a plugin that names one migration twice (`Auth/MigrationDeclarationInvalid`, BEH-EA-038).

Migration: none required. A plugin that declares two migrations with the same name now fails `Auth.make`; rename one by appending a new migration (never rename an applied one).
