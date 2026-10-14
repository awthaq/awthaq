---
"@awthaq/device-authorization": minor
---

`DeviceAuthorization.records` is the plugin's grant and client stores as one matched `{ memory, sql }` bundle, and the stores' service keys gain the `/records/` segment.

- `DeviceGrantRecords` and `DeviceClientRecords` are keyed `awthaq/device-authorization/records/<Name>`; the bundle provides both over memory and over SQL, and `AuthPlugin.layer` refuses a layer that requires a store the bundle does not provide.

Migration: code that built a `Context` by the old key string must use the class. A host replaces the pair of `layerMemory` / `layerSql` layers with `DeviceAuthorization.records.memory` / `DeviceAuthorization.records.sql`.
