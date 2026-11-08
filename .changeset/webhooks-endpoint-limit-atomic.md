---
"@awthaq/webhooks": patch
---

`maxEndpoints` holds under concurrency (plan 25, ADR-EA-041 decision 9, BEH-EA-281/309). `Webhooks.createEndpoint` keeps its early count, so a full tenant is refused before the DNS lookup, but the decision is now `WebhookRecords.createEndpoint(input, { within })`, which counts the tenant's endpoints and inserts as one step (memory: one `Ref.modify`; SQL: one transaction under the per-tenant lock `webhooks_endpoint:tenant:<tenant>` on Postgres). Concurrent registrations at `maxEndpoints - 1` store one; the rest answer `WebhookEndpointLimitReached`.

- An administrator's PATCH racing the worker's failure count keeps both: `updateEndpoint` writes only the patched columns in one statement, disabling no longer writes `consecutiveDead` back, and re-enabling resets it in the same statement.
- `deleteEndpoint` removes the endpoint and its deliveries in one transaction, so a failure between the two no longer leaves orphan deliveries.
- A test ping whose endpoint is deleted while it is queued answers `WebhookEndpointNotFound` (404), not a defect.
- `layerMemory`'s `claimDue` hands claimed rows out as leased (`nextAttemptAt` is the lease's end), like `layerSql`.

Migration: a custom `WebhookRecords` adapter (`WebhookRecords.WebhookRecordsShape`, exported from `@awthaq/webhooks`) must accept `createEndpoint(input, { within? })` and, when `within` is given, refuse with `WebhookRecordLimitReached` (`"WebhookRecords/LimitReached"`) once the ambient tenant has that many endpoints, counting and inserting atomically. `updateEndpoint` and `setDisabled` must not write columns they were not asked to change, and `deleteEndpoint` must remove the endpoint and its deliveries together.
