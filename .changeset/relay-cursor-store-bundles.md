---
"@awthaq/core": minor
"@awthaq/sql": minor
"@awthaq/webhooks": minor
"@awthaq/test": minor
---

`Persistence.memory` and `Persistence.sql()` provide the event relay's position, so `EventRelay.layer` and `Webhooks.Webhooks.background()` need nothing else for it; a cursor-store outage is `StoreUnavailable` instead of a defect, and a busy cursor write is retried instead of redelivering the batch (ADR-EA-028). The position only moves forward, so relays sharing a name no longer pull each other back (ADR-EA-030 rev 1.2).

Migration: delete `EventRelay.layerCursorSql` / `EventRelay.layerCursorMemory` and `Repositories.RelayCursorRepositoryLive` from your composition (the bundle provides the store); `EventRelay.RelayCursorStore` is now `RelayCursorStore.RelayCursorStore` from `@awthaq/ports`, and its `set(name, id)` is `advance({ name, lastEventId, at })`. A custom implementation must make `advance` monotonic and pass `StoreContract.relayCursor`.
