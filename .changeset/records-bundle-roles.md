---
"@awthaq/roles": minor
---

`Roles` persists through a record store, `RoleAssignments`, declared as `Roles.records` (a matched `{ memory, sql }` bundle), and `Roles.layerSql` is removed.

- New record store `RoleAssignments` (key `awthaq/roles/records/RoleAssignments`) with `layerMemory` and `layerSql`. `Roles` is now written once over it: catalog validation, `UnknownRole` and the audit events live in one implementation instead of two copies over different storage. `Roles.layer` requires the store.

Migration: `Roles.layer` now requires `RoleAssignments`: provide `Roles.records.memory` (what `Roles.layer` used to carry) beneath it. `Roles.layerSql` is gone: use `Roles.layer` with `Roles.records.sql` (`Roles.layer.pipe(Layer.provide(Roles.records.sql), Layer.provide(Roles.config(catalog)))`). A composition served through `Auth.make` and `TestAuth.layer` needs nothing: the harness selects the bundle.
