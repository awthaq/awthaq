# @awthaq/sql

Persistence stratum (3): database-neutral models, repositories and the core migrations.

**Shipped**

- `Models` (BEH-EA-033/034): `User`, `Account`, `Session`, `VerificationToken` and `VerificationReservation` as `Model.Class` entities, sensitive fields excluded from the JSON variants.
- `Repositories` (BEH-EA-035/036): `SqlModel.makeRepository`-based repositories over the ambient `SqlClient` (keyset pagination, atomic claims for verification tokens — ADR-EA-016, plus the audit-log repository). They never open their own transactions; the domain service that composes them holds the boundary via `@awthaq/ports`'s `SqlTransaction`.
- `CoreMigrations`: the core tables' migrations, dialect-branched (SQLite and Postgres).

`@awthaq/core`'s `Users`/`Accounts`/`Sessions`/`Verification`/`AuditLog` each ship a `layerSql` over these repositories next to their in-memory `layerMemory`.

See [`spec/behaviors/05-persistence-stratum.md`](../../spec/behaviors/05-persistence-stratum.md).
