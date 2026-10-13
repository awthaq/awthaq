---
"@awthaq/api-key": minor
"@awthaq/device-authorization": minor
"@awthaq/passkey": minor
"@awthaq/roles": minor
"@awthaq/qadi": minor
---

The remaining plugin stores fail with `StoreUnavailable` instead of dying (plan 05, ADR-EA-028).

- `ApiKeyRecords`, `ApiKeyClientRecords`, `DeviceGrantRecords`, `DeviceClientRecords`, `PasskeyCredentials` (`recordUsage` included), `PasskeyUserHandles`, `ChallengeStore`, `Roles` (`assign`, `revoke`, `listRoleNames`, `holders`, `listUnknownAssignments`) and `UserClaims` (`get`, `set`, `merge`, `delete`) answer a database failure with the typed `StoreUnavailable` naming `<Records>.<method>`; the services built on them (`ApiKey`, `DeviceAuthorization`, `Passkey`, `RolesAdmin`) widen their `E` accordingly. All their tables are Global (no tenant column).
- An API-key service-token resolver and a JWT bearer resolver let an outage through as `StoreUnavailable` (a `503`) instead of answering `401`. `@awthaq/qadi`'s `SubjectResolver.resolve` and its `AuthorizedSubject` middleware may fail with `StoreUnavailable` (a roles lookup that is down is no longer a defect), and `UserClaimsAttributes` / `OrganizationQadi` answer it as their own typed resolve error so the policy engine fails closed.

Migration: handle `StoreUnavailable` on the widened methods; an application that implements `SubjectResolverShape`, `RolesShape`, `ChallengeStoreShape` or one of the records shapes adopts the wider `E`. BEH-EA-325.
