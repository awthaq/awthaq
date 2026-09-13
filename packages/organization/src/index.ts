// @awthaq/organization — Plugin (M7)
//
// Multi-tenancy: organizations, per-membership + dynamic per-org roles,
// teams, invitations, lifecycle hooks, and a qadi relationship/attribute
// resolver — matching better-auth's Organization plugin's full capability
// set. See `.scratch/organization/spec.md` for the full design.
//
// See spec/overview.md for the full package map.

export * as ActiveContextRecords from "./ActiveContextRecords.ts";
export * as InvitationRecords from "./InvitationRecords.ts";
export * as MembershipRecords from "./MembershipRecords.ts";
export * as Organization from "./Organization.ts";
export * as OrganizationHooks from "./OrganizationHooks.ts";
export * as OrganizationApi from "./OrganizationApi.ts";
export * as OrganizationQadi from "./OrganizationQadi.ts";
export * as OrganizationRecords from "./OrganizationRecords.ts";
export * as OrgRoleRecords from "./OrgRoleRecords.ts";
export * as PermissionEngine from "./PermissionEngine.ts";
export * as TeamRecords from "./TeamRecords.ts";
