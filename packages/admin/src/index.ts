// @awthaq/admin — Plugin (M7)
//
// Impersonation: off by default, admin-gated, reason required, hard expiry, dual identity, fully audited (NFR-EA-007).
//
// spec/behaviors/27-admin-impersonation.md, BEH-EA-209 through BEH-EA-220.
// See spec/overview.md for the full package map.

export * as Admin from "./Admin.ts";
export * as AdminApi from "./AdminApi.ts";
export * as AdminTenants from "./AdminTenants.ts";
export * as AdminTenantsApi from "./AdminTenantsApi.ts";
export * as ImpersonationOwnerNotice from "./ImpersonationOwnerNotice.ts";
export * as ImpersonationRecords from "./ImpersonationRecords.ts";
