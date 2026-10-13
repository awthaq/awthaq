---
"@awthaq/scim": minor
---

`Scim.records` is the plugin's record store as one matched `{ memory, sql }` bundle, and `Scim.layer` now provides its bearer authentication and connection store itself.

- `ScimRecords` is keyed `awthaq/scim/records/ScimRecords`; the bundle provides it over memory and over SQL.
- `Scim.layer` absorbs `ScimConnections.ScimAuthenticationLive` (the plugin-owned `ScimAuthentication` middleware its group declares) and `ScimConnections.layerStore` (always required, built over `ScimRecords`); both stay in its output.

Migration: remove your own `ScimConnections.ScimAuthenticationLive` and `ScimConnections.layerStore` from the host graph (keeping them is harmless but redundant). Code that built a `Context` by the old record key string must use the class. A host replaces `ScimRecords.layerMemory` / `ScimRecords.layerSql` with `Scim.records.memory` / `Scim.records.sql`.
