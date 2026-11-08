---
"@awthaq/cli": patch
"@awthaq/next": patch
"@awthaq/sql": patch
---

README recipes point at `AuthHost.layer`: the CLI's `app` is the served composition with `migrations: "verify"` (a `seed admin` or `import` run never migrates behind `migration apply --yes`), the Next adapter's in-process handler serves an `AuthHost` layer, and the SQL package's "Two ledgers" note says `AuthHost` and `awthaq migration apply` run core then plugins through `Migrations.apply`, refusing a drifted ledger.

Migration: none (documentation only).
