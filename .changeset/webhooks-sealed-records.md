---
"@awthaq/webhooks": minor
---

Webhooks: `secret`, `previousSecret` and `headers` are `SealedColumn`s, and the records fail with `StoreUnavailable` instead of dying (plan 05 phase 4).

- `WebhookRecords` accepts plaintext `Redacted` values (`createEndpoint`, `setSecrets`) and hands out `Sealed` values (`EndpointRecord.secret`, `previousSecret`, `headers`); the AAD is `webhooks_endpoint:<id>:<column>`, envelopes under the old `webhooks-endpoint:<id>:<field>` spelling or a retired key still open and are re-sealed on read. `WebhookSecrets.aad`, `seal` and `sealHeaders` are removed; `open` and `openHeaders` no longer take an `Encryption`.
- Every `WebhookRecordsShape` member gains `StoreUnavailable` in its error channel (the SQL adapter's `Effect.orDie` is gone); `WebhooksShape` methods gain it too, and the admin endpoints answer 503 behind `AdminAuthentication`. A failed `claimDue` is logged and retried on the next worker tick. `enqueue` and `drainDue` can fail with `StoreUnavailable`.
- `Webhooks` and `WebhookDelivery` no longer require `Encryption`; `WebhookRecords.layerMemory` and `layerSql` do. `layerMemory` also provides `WebhookRecords.MemoryEnvelopes`, the test seam the sealed-column suite uses.

Migration: custom `WebhookRecords` implementations hand out `Sealed` values and take plaintext secrets and headers; replace `WebhookSecrets.seal`/`sealHeaders`/`aad` with the records. Provide `Encryption` to the records layer (`Layer.provide`), not to `Webhooks`. Stored secrets re-seal on read; run `SealedColumn.sweep` per column to finish the rest. BEH-EA-276, BEH-EA-324, BEH-EA-325.
