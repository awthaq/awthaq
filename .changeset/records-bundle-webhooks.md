---
"@awthaq/webhooks": minor
---

`Webhooks.records` is the plugin's record store as one matched `{ memory, sql }` bundle, and the store's service key gains the `/records/` segment.

- `WebhookRecords` is keyed `awthaq/webhooks/records/WebhookRecords`; the bundle provides it over memory and over SQL, and `AuthPlugin.layer` refuses a layer that requires a store the bundle does not provide. The `MemoryEnvelopes` test seam is not part of the bundle. `WebhookTransport` stays a host-provided adapter (it is the delivery worker's, not a record store).

Migration: code that built a `Context` by the old key string must use the class. A host replaces `WebhookRecords.layerMemory` / `WebhookRecords.layerSql` with `Webhooks.records.memory` / `Webhooks.records.sql`.
