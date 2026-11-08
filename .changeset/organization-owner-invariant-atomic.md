---
"@awthaq/organization": patch
---

Removing, demoting or leaving can no longer leave an organization without an owner when two such requests race; a concurrent second removal of one member answers 404, not 500. `MembershipRecords.remove` and `updateRole` now refuse with the new `MembershipRecordLastOwner` (`"MembershipRecords/LastOwner"`) when the write would take `owner` from the organization's only owner, deciding atomically on every adapter (memory: one `Ref.modify`; SQL: one transaction that takes a per-organization advisory lock on Postgres first). `removeAllForOrganization` and `deleteAllByUser` stay unguarded by design (organization deletion; erasure).

Migration: A custom `MembershipRecords` adapter (through `@awthaq/organization/records`) must refuse `MembershipRecordLastOwner` atomically in `remove` and `updateRole`. On Postgres, take a lock per organization before counting owners; a transaction alone is not enough under READ COMMITTED. BEH-EA-285, ADR-EA-041.
