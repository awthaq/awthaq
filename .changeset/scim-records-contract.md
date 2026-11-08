---
"@awthaq/scim": patch
---

`ScimRecords` has a RecordsContract suite (plan 25 ticket 23, ADR-EA-041 decision 9, BEH-EA-246/247):

- Linking a resource the connection already links (the same connection, kind and resource id) is `ScimLinkConflict` (`field: "name"`, the field Postgres reports for the primary key) on every adapter. Before, the memory adapter added a second row (plan 24's SCIM link item).
- `removeAllForOrganization` deletes the mappings and their connections in one transaction (a savepoint inside the organization deletion's).
- A revocation outage is labelled `ScimRecords.revokeConnection` (was `ScimRecords.row`).
- Every operation carries a verdict; `link`, `setExternalId` and `revokeConnection` are proven atomic by 8-way race cases on memory and SQL, Postgres included under `pnpm test:pg`.

Migration: a custom adapter through `@awthaq/scim`'s `ScimRecords` must refuse `link` of an already linked resource with `ScimLinkConflict` rather than storing a second row.
