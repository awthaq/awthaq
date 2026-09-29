---
"@awthaq/qadi": minor
"@awthaq/roles": minor
"@awthaq/organization": minor
"@awthaq/admin": minor
"@awthaq/react": minor
"@awthaq/webhooks": minor
"@awthaq/cli": minor
---

Requires `@qadi/core`, `@qadi/http` and `@qadi/react` `^0.8.0` (was `^0.7.0`).

`@qadi/http` 0.8.0 answers the `RequirePermission` refusals with typed bodies instead of empty ones so a generated `HttpApiClient` can decode them: a 403 `AccessDenied` carries qadi's public denial view (`subjectId`, `policyTag`, `reason`; never the evaluation trace), a 403 `UndischargedObligation` its tag, a 502 resolver outage its tag plus at most one identifying attribute (never the cause or the resolver's own message); the wiring-mistake 500 stays empty. BEH-EA-157 / REQ-EA-440 (PV-230).

Migration: bump the three `@qadi/*` dependencies to `^0.8.0` together; a host that asserted an empty 403 or 502 body from `RequirePermission` now sees the typed view.
