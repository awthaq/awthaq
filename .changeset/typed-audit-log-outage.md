---
"@awthaq/core": minor
---

`AuditLog` fails with the typed `StoreUnavailable` instead of dying on an outage, `AuthEvents.publish` applies an explicit `AuditWritePolicy`, and hot session writes retry transient SQL failures.

- Every `AuditLog` method (`record`, `list`, `replay`, `pseudonymizeActor`, `purge`) carries `StoreUnavailable` in its error channel; `DataExport`, `Retention` and `EventRelay` propagate it.
- `AuthEvents.publish` stays `Effect<void>`. When the audit row cannot be written it now logs, counts `awthaq_audit_write_failed_total{tag}` and lets the operation succeed (`"bestEffort"`, the new default), or dies with the `StoreUnavailable` (`"required"`, the previous behaviour) when the layer is built with `AuthEvents.auditWritePolicy("required")`.
- `Errors.retryTransient` bounds a jittered-exponential retry of a retryable `SqlError` (`SQLITE_BUSY`, deadlock, serialization failure); `Sessions.issue` and the idle-refresh touch in `Sessions.verify` use it (SEA-002).

Migration: a caller of `AuditLog.list`/`replay`/`record`/`pseudonymizeActor`/`purge` handles (or lets propagate) `StoreUnavailable`. A deployment that must never complete an operation without its audit row provides `AuthEvents.auditWritePolicy("required")`. ADR-EA-028 (revision 1.1), BEH-EA-100.
