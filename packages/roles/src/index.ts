// @awthaq/roles — Plugin (M3)
//
// A SubjectResolver override that flattens roles through a role DAG into
// qadi's AuthSubject.
//
// Implemented: Roles.ts (spec/behaviors/18-roles-subject-resolver.md,
// BEH-EA-138 through BEH-EA-141 — see that module's own header comment for
// the deliberately deferred parts).
// See spec/overview.md for the full package map.

export * as Roles from "./Roles.ts";
export * as RolesAdmin from "./RolesAdmin.ts";
export * as RolesAdminApi from "./RolesAdminApi.ts";
