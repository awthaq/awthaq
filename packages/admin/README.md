# @awthaq/admin

Admin impersonation: off by default, admin-gated, reason required, hard expiry, dual identity, fully audited (NFR-EA-007). Endpoints: `POST /admin/impersonate/:userId`, `POST /admin/stop-impersonating`, `POST /admin/force-stop/:sessionId`, `GET /admin`. Impersonation records persist via `ImpersonationRecords` (memory and SQL), and the impersonated identity reaches qadi as the `actingAs` subject attribute.

See [`spec/behaviors/27-admin-impersonation.md`](../../spec/behaviors/27-admin-impersonation.md) (BEH-EA-209–220) and [`spec/models/15-admin-impersonation.md`](../../spec/models/15-admin-impersonation.md).
