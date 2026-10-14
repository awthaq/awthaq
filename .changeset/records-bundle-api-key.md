---
"@awthaq/api-key": minor
---

`ApiKey.records` is the plugin's key and client stores as one matched `{ memory, sql }` bundle, and the stores' service keys gain the `/records/` segment.

- `ApiKeyRecords` and `ApiKeyClientRecords` are keyed `awthaq/api-key/records/<Name>`; the bundle provides both over memory and over SQL, and `AuthPlugin.layer` refuses a layer that requires a store the bundle does not provide. `CredentialResolvers` stays the composition's registry (a `TestAuth` composition provides it).

Migration: code that built a `Context` by the old key string must use the class. A host replaces the pair of `layerMemory` / `layerSql` layers with `ApiKey.records.memory` / `ApiKey.records.sql`.
