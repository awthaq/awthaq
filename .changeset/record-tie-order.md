---
"@awthaq/device-authorization": patch
"@awthaq/jwt": patch
---

Rows created at the same instant now come back in one deterministic order on every adapter. `DeviceGrantRecords.listByUser` (memory twin) and `SigningKeyRecords.findCurrent` / `listVerifiable` (memory and SQL) break `createdAt` ties by id (`kid` for signing keys), through the shared `Keyset.chronological`. Their `RecordsContract` suites gain a tie case each.

Migration: ordering of equal-createdAt rows is now deterministic by id: ascending for device grants (as SQL already ordered them), descending by `kid` for signing keys. A third-party adapter of either store must break ties the same way to pass the new contract cases.
