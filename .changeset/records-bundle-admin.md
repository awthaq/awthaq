---
"@awthaq/admin": minor
---

`Admin.records` is the plugin's impersonation store as one matched `{ memory, sql }` bundle, and the store's service key gains the `/records/` segment.

- `ImpersonationRecords` is keyed `awthaq/admin/records/ImpersonationRecords`; the bundle provides it over memory and over SQL. `AdminAccounts` and `AdminTenants` own no stores (the latter reads organization state through `dependsOn`).

Migration: code that built a `Context` by the old key string must use the class. A host replaces `ImpersonationRecords.layerMemory` / `ImpersonationRecords.layerSql` with `Admin.records.memory` / `Admin.records.sql`.
