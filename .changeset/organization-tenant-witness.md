---
"@awthaq/organization": minor
"@awthaq/sql": minor
"@awthaq/admin": patch
"@awthaq/saml": patch
"@awthaq/scim": patch
---

The organization records are scoped by their organization key, a cross-organization method takes a witness, the client secret is a sealed column, and every store failure is `StoreUnavailable` (plan 05).

- Every method that reads or writes across organizations takes a `TenantScoped.CrossTenant` as its first argument (`OrganizationRecords.listByIds/listPage/setSuspended`, `MembershipRecords.listByUser/deleteAllByUser`, `InvitationRecords.findById/findByTokenHash/listByEmail/listByInviter/countPendingByInviter/removeAllForUser`, `TeamRecords.findTeamByIdAnyOrg/removeUserFromAllTeams`, `ConnectionRecords.findByEmailDomain`, `ActiveContextRecords.deleteAllByUser`); its statement runs under `TenantScoped.lift`, so it still sees every organization inside a request's Postgres RLS transaction. `InvitationRecords.setTokenHash/updateStatus` and the connection-domain deletes now also filter by `organizationId`.
- `ConnectionRecord.clientSecret` is `Option<SealedColumn.Sealed<string>>` (and `secretRevision` is the compare-only ciphertext fingerprint); `ConnectionInput`/`ConnectionPatch` take a `Redacted` secret. Secrets sealed under the old `organization-oauth-connection:` AAD still open and re-seal on read. `ConnectionRecords.layerMemory/layerSql` require `Encryption`; `OrganizationConnections` and its store no longer do.
- The records modules, `OrganizationShape`, `OrganizationConnectionStore`, `AdminTenants` and the SAML/SCIM services fail with `StoreUnavailable` instead of dying; the tenant middleware answers it `503`; the SCIM bearer middleware and the SAML metadata/SSO endpoints declare it. `@awthaq/sql` adds `StoreFailure.orConflict` and `TenantScoped.liftOn`, and `orStoreUnavailable` accepts a `RETURNING` that returned no row (a defect).

Migration: pass a witness (`TenantScoped.crossTenant("<why>")` from `@awthaq/sql`) to the methods above, and pass `organizationId` to `InvitationRecords.setTokenHash/updateStatus`; open a connection's secret with `SealedColumn.option(record.clientSecret.value.open)`; provide `Encryption` to `ConnectionRecords`; handle `StoreUnavailable` on the widened service methods. BEH-EA-284, BEH-EA-328.
