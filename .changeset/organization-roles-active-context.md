---
"@awthaq/organization": patch
---

Dynamic roles and a session's active context are system modules, `OrganizationRoles` and `OrganizationActiveContext`, exposed by `Organization.layer` (ADR-EA-040). `OrganizationRoles` owns the `dynamicAccessControl.enabled` gate, the reserved names (RZS-005), the grant `Bound` over a role's statements, `maximumRolesPerOrganization`, the veto and observe points and the events; `OrganizationActiveContext` owns the per-session pointers (MTI-001), the suspension rule and the re-validation on read (CWM-003). The authorized `createRole`, `listRoles`, `getRole`, `updateRole`, `deleteRole`, `getActiveMember`, `getActiveMemberRole`, `setActive`, `getActive` and `setActiveTeam` delegate with unchanged signatures and error unions. `Organization.ts` is now the plugin class, the authorized interface and its implementation (838 lines, from 3,879) and reads no records of its own beyond a membership lookup through `OrganizationMembers`.

Migration: additive; new exports `OrganizationRoles`, `OrganizationActiveContext`. No behaviour change for HTTP callers.
