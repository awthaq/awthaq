---
"@awthaq/webhooks": patch
---

Webhooks tenant isolation moves from the service into the records store (plan 05, BEH-EA-309). `webhooks_endpoint` was read tenant-blind and the service filtered every tenant's rows in memory, so one missed check was a cross-tenant mutation and RLS could not back it up.

- `WebhookRecords` stamps `createEndpoint` with the ambient tenant (it no longer takes `tenantId`) and confines `findEndpoint`, `listEndpoints`, `updateEndpoint`, `setSecrets`, `setDisabled`, `deleteEndpoint`, `findDelivery`, `listDeliveries` and `redrive` to it, in SQL and in memory. The relay and the worker, which run with no tenant, call `listEnabledEndpoints`, `findEndpointForDelivery`, `claimDue`, `markSucceeded`, `reschedule`, `defer`, `markDead`, `bumpDead`, `clearDead`, `disableFailing`, `pruneFinished`, `deleteBySubject` and `listBySubject` with a `TenantScoped.CrossTenant` witness.
- `Webhooks` no longer filters in the service; the erasure and export contributions present their own witness.

Migration: a host or test with its own `WebhookRecordsShape` implementation adds the witness parameter to the relay methods listed above, gains `listEnabledEndpoints`, `findEndpointForDelivery` and `disableFailing`, and drops `tenantId` from `createEndpoint` (register the endpoint inside `Tenant.withTenant(id)`). Code that read a tenant's endpoints or deliveries with no tenant in scope now sees only the platform's.
