# @awthaq/core

Domain stratum (4): the plugin contract, `Auth.make` composition and the domain services every plugin builds on.

**Shipped**

- `AuthPlugin` / `Auth` (BEH-EA-001–016): `AuthPlugin.Service` plugin classes, `Auth.make` composing a plugin tuple into one `api`, `layer`, and manifest.
- Domain services, each with `layerMemory` and a SQL-backed `layerSql`: `Users`, `Accounts`, `Sessions` (rotation, reuse detection, `authenticatedAt`), `Verification` (single-use tokens, reservations), `AuditLog`.
- `AuthEvents` (BEH-EA-097–104) — a non-blocking event bus that also records every event durably via `AuditLog` — and the closed `AuthEvent` union.
- `HookPoint` / `Hooks` (BEH-EA-089–096): veto / observe / divert points and their taps.
- `Slots`, `RateLimits`, `Migrations`, and the re-exported `HttpApi*` contract classes a plugin author imports from here.

See [`spec/overview.md`](../../spec/overview.md) and [`spec/behaviors/`](../../spec/behaviors/).
