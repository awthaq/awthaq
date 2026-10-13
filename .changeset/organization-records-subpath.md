---
"@awthaq/organization": minor
---

The record stores move to a sub-path, `@awthaq/organization/records` (ADR-EA-040, BEH-EA-330): `ActiveContextRecords`, `ConnectionRecords`, `InvitationRecords`, `MembershipRecords`, `OrganizationRecords`, `OrgRoleRecords` and `TeamRecords` are no longer exported from the package root. Every write to an `organization_*` table goes through one system module, and no other plugin imports the records (a static guard, `RecordsBoundary.test.ts`, refuses it). `OrganizationMemory` and the system modules stay at the root.

Migration: `import { TeamRecords } from "@awthaq/organization"` becomes `import { TeamRecords } from "@awthaq/organization/records"` (same names). A host that composes its own record layers, a test that arranges rows and a conformance suite use the sub-path.
