# @awthaq/core

Domain stratum (4): the plugin contract, `Auth.make` composition and the domain services every plugin builds on.

**Shipped**

- `AuthPlugin` / `Auth` (BEH-EA-001–016): `AuthPlugin.Service` plugin classes, `Auth.make` composing a plugin tuple into one `api`, `layer`, and manifest.
- Domain services, each with `layerMemory` and a SQL-backed `layerSql`: `Users`, `Accounts`, `Sessions` (rotation, reuse detection, `authenticatedAt`), `Verification` (single-use tokens, reservations), `AuditLog`.
- `AuthEvents` (BEH-EA-097–104) — a non-blocking event bus that also records every event durably via `AuditLog` — and the closed `AuthEvent` union.
- `HookPoint` / `Hooks` (BEH-EA-089–096): veto / observe / divert points and their taps.
- `UserFields` (BEH-EA-040/048, ADR-EA-035): a plugin declares typed scalar fields on `users` (`userFields: { plan: UserFields.serverOnly(Schema.Literals(["free", "pro"])), nickname: UserFields.field(Schema.String) }`); `Auth.make` generates their `<plugin id>_<field>` columns, `Users.typedFields(auth.userFields)` reads and writes them typed, a field is client-writable through `PATCH /user` unless declared `serverOnly`, and `auth.userFieldsLayer` provides the registry `Users` validates against.
- `EmailChange` (BEH-EA-042/058): the `change-email` verification purpose shared by a user's own address change (`@awthaq/password`) and an administrator's (`@awthaq/admin`).
- `Slots`, `RateLimits`, `Migrations`, and the re-exported `HttpApi*` contract classes a plugin author imports from here.

Writing a plugin? Start from [`docs/plugin-authoring.md`](../../docs/plugin-authoring.md) and copy [`examples/plugin-template/`](../../examples/plugin-template/) (a test-exercised template).

See [`spec/overview.md`](../../spec/overview.md) and [`spec/behaviors/`](../../spec/behaviors/).
