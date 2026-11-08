---
"@awthaq/organization": patch
---

Role endpoints answer a non-member `404` whether or not dynamic access control is enabled.

- `createRole`, `listRoles`, `getRole`, `updateRole` and `deleteRole` check the caller's membership before the dynamic-access-control gate (the PV-300 order the team endpoints already use). With the feature off (the default), an outsider used to get `403 DynamicAccessControlDisabled` for an existing organization and `404 OrganizationNotFound` for an unknown one, which told any signed-in user which organization ids exist (BEH-EA-284). A non-member's attempt on a role endpoint is now recorded `auth.organization.permissionDenied` with reason `notMember` whether or not the feature is on.

Migration: a client that relied on `403 DynamicAccessControlDisabled` to learn that the feature is off must ask as a member. Nothing else changes.
