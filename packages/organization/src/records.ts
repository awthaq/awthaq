// @awthaq/organization/records — the record stores behind the organization plugin
//
// Plan 04 phase 8 (ADR-EA-040): the `organization_*` tables are written by exactly one system module per
// sub-domain (`OrganizationDirectory`, `OrganizationMembers`, ...); no other plugin reaches them, so the
// stores are not part of the package's root export. This sub-path is for composition and test arrangement:
// a host that provides its own record layers (a different database), a test that arranges rows, a
// conformance suite. A plugin importing it from `packages/*/src` is refused by
// `test/RecordsBoundary.test.ts`.
//
// Who owns which writes:
//
//   organization_org                          OrganizationDirectory
//   organization_membership                   OrganizationMembers (and Directory / Invitations create the first)
//   organization_team, _team_membership/_closure   OrganizationTeams (and Members/Directory cascades)
//   organization_invitation                   OrganizationInvitations (Directory cascade, erasure)
//   organization_role                         OrganizationRoles (Directory cascade)
//   organization_active_context               OrganizationActiveContext (cascades)
//   organization_oauth_connection(+_domain)   OrganizationConnectionStore (OrganizationDeletion contribution)
//   organization_domain_owner / _claim         OrganizationConnectionStore and SamlConnectionStore (BEH-EA-317)

export * as ActiveContextRecords from "./ActiveContextRecords.ts";
export * as ConnectionRecords from "./ConnectionRecords.ts";
export * as DomainClaims from "./DomainClaims.ts";
export * as InvitationRecords from "./InvitationRecords.ts";
export * as MembershipRecords from "./MembershipRecords.ts";
export * as OrganizationRecords from "./OrganizationRecords.ts";
export * as OrgRoleRecords from "./OrgRoleRecords.ts";
export * as TeamRecords from "./TeamRecords.ts";
