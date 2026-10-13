---
"@awthaq/organization": minor
---

`Organization.records` is the plugin's record stores as one matched `{ memory, sql }` bundle, and the stores' service keys gain the `/records/` segment.

- The seven stores (`OrganizationRecords`, `MembershipRecords`, `ActiveContextRecords`, `InvitationRecords`, `OrgRoleRecords`, `TeamRecords`, `ConnectionRecords`) are keyed `awthaq/organization/records/<Name>`; `Organization.layer` requires them and the compiler checks the bundle provides every one. `ConnectionRecords` is in the bundle although the plugin layer does not require it itself (it backs `organization_oauth_connection*`).

Migration: code that built a `Context` by the old key string must use the class (`Context.get(context, OrganizationRecords.OrganizationRecords)`). A host replaces the six hand-listed `layerMemory`/`layerSql` layers with `Organization.records.memory` / `Organization.records.sql` (`OrganizationMemory.layer` stays for now and lacks `ConnectionRecords`).
