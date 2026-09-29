// @awthaq/organization — OrganizationApi
//
// This plugin's own contract — one group, `organization`, every endpoint
// behind `.middleware(Api.Authentication)` (mirroring `@awthaq/admin`'s
// own `AdminApi.ts`): every operation requires a real, already-authenticated
// caller, gated again inside the handler by `PermissionEngine`/membership
// checks where the operation is mutating.
//
// Ticket 09 establishes this group empty-but-real; tickets 11/12 add the
// organization-CRUD and membership endpoints below in the same pass.

import { Api } from "@awthaq/api";
import { HookPoint } from "@awthaq/core";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

// ---- errors -----------------------------------------------------------------

export class OrganizationSlugTaken extends Schema.TaggedError<OrganizationSlugTaken>()(
  "OrganizationSlugTaken",
  {},
  { httpApiStatus: 409 },
) {}

export class OrganizationNotFound extends Schema.TaggedError<OrganizationNotFound>()(
  "OrganizationNotFound",
  {},
  { httpApiStatus: 404 },
) {}

export class OrganizationDeletionDisabled extends Schema.TaggedError<OrganizationDeletionDisabled>()(
  "OrganizationDeletionDisabled",
  {},
  { httpApiStatus: 403 },
) {}

export class OrganizationLimitReached extends Schema.TaggedError<OrganizationLimitReached>()(
  "OrganizationLimitReached",
  {},
  { httpApiStatus: 403 },
) {}

export class OrganizationCreationNotAllowed extends Schema.TaggedError<OrganizationCreationNotAllowed>()(
  "OrganizationCreationNotAllowed",
  {},
  { httpApiStatus: 403 },
) {}

/** A `PermissionEngine` rejection on any of this plugin's own mutating endpoints. */
export class OrganizationPermissionDenied extends Schema.TaggedError<OrganizationPermissionDenied>()(
  "OrganizationPermissionDenied",
  {},
  { httpApiStatus: 403 },
) {}

export class MembershipNotFound extends Schema.TaggedError<MembershipNotFound>()(
  "MembershipNotFound",
  {},
  { httpApiStatus: 404 },
) {}

export class MembershipLimitReached extends Schema.TaggedError<MembershipLimitReached>()(
  "MembershipLimitReached",
  {},
  { httpApiStatus: 403 },
) {}

/** spec.md's native owner invariant: an organization must always retain ≥1 owner. */
export class OwnerInvariantViolation extends Schema.TaggedError<OwnerInvariantViolation>()(
  "OwnerInvariantViolation",
  {},
  { httpApiStatus: 409 },
) {}

export class NoActiveOrganization extends Schema.TaggedError<NoActiveOrganization>()(
  "NoActiveOrganization",
  {},
  { httpApiStatus: 404 },
) {}

export class InvitationNotFound extends Schema.TaggedError<InvitationNotFound>()(
  "InvitationNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/** The invitation exists but isn't `pending` any more (already accepted/rejected/canceled/expired). */
export class InvitationNotPending extends Schema.TaggedError<InvitationNotPending>()(
  "InvitationNotPending",
  {},
  { httpApiStatus: 409 },
) {}

export class InvitationExpired extends Schema.TaggedError<InvitationExpired>()(
  "InvitationExpired",
  {},
  { httpApiStatus: 410 },
) {}

/** `accept`/`reject`: the caller's own email doesn't match the invitation's. */
export class InvitationEmailMismatch extends Schema.TaggedError<InvitationEmailMismatch>()(
  "InvitationEmailMismatch",
  {},
  { httpApiStatus: 403 },
) {}

export class InvitationLimitReached extends Schema.TaggedError<InvitationLimitReached>()(
  "InvitationLimitReached",
  {},
  { httpApiStatus: 403 },
) {}

export class EmailVerificationRequired extends Schema.TaggedError<EmailVerificationRequired>()(
  "EmailVerificationRequired",
  {},
  { httpApiStatus: 403 },
) {}

export class DynamicAccessControlDisabled extends Schema.TaggedError<DynamicAccessControlDisabled>()(
  "DynamicAccessControlDisabled",
  {},
  { httpApiStatus: 403 },
) {}

export class OrgRoleNotFound extends Schema.TaggedError<OrgRoleNotFound>()(
  "OrgRoleNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/** MTI-003/OHS-006: the user already holds a membership in this organization; a role change goes through `updateMemberRole`, never through add/invite/accept. */
export class AlreadyMember extends Schema.TaggedError<AlreadyMember>()(
  "AlreadyMember",
  {},
  { httpApiStatus: 409 },
) {}

/** OHS-003: the user is already on this team. */
export class AlreadyTeamMember extends Schema.TaggedError<AlreadyTeamMember>()(
  "AlreadyTeamMember",
  {},
  { httpApiStatus: 409 },
) {}

/** RZS-005/N8: a dynamic role may not take a built-in tier's name (`owner`/`admin`/`member`) or an `OrganizationConfig.permissionStatements` key. */
export class ReservedOrgRoleName extends Schema.TaggedError<ReservedOrgRoleName>()(
  "ReservedOrgRoleName",
  {},
  { httpApiStatus: 409 },
) {}

/** RRM-001/RRM-002: a role name that is not built-in, static-custom, or a live dynamic role of this organization. */
export class UnknownOrgRole extends Schema.TaggedError<UnknownOrgRole>()(
  "UnknownOrgRole",
  {},
  { httpApiStatus: 422 },
) {}

export class OrgRoleNameTaken extends Schema.TaggedError<OrgRoleNameTaken>()(
  "OrgRoleNameTaken",
  {},
  { httpApiStatus: 409 },
) {}

/** ticket 15's self-escalation guard: a caller can never grant a permission they don't already hold. */
export class RolePermissionEscalation extends Schema.TaggedError<RolePermissionEscalation>()(
  "RolePermissionEscalation",
  {},
  { httpApiStatus: 403 },
) {}

export class RoleLimitReached extends Schema.TaggedError<RoleLimitReached>()(
  "RoleLimitReached",
  {},
  { httpApiStatus: 403 },
) {}

// ---- teams --------------------------------------------------------------------

export class TeamsDisabled extends Schema.TaggedError<TeamsDisabled>()(
  "TeamsDisabled",
  {},
  { httpApiStatus: 403 },
) {}

export class TeamNotFound extends Schema.TaggedError<TeamNotFound>()(
  "TeamNotFound",
  {},
  { httpApiStatus: 404 },
) {}

export class TeamLimitReached extends Schema.TaggedError<TeamLimitReached>()(
  "TeamLimitReached",
  {},
  { httpApiStatus: 403 },
) {}

export class TeamMemberLimitReached extends Schema.TaggedError<TeamMemberLimitReached>()(
  "TeamMemberLimitReached",
  {},
  { httpApiStatus: 403 },
) {}

/** spec.md's `allowRemovingAllTeams` guard (default `false`). */
export class LastTeamCannotBeRemoved extends Schema.TaggedError<LastTeamCannotBeRemoved>()(
  "LastTeamCannotBeRemoved",
  {},
  { httpApiStatus: 409 },
) {}

/** OHS-001: a move would place a team under itself or one of its own descendants. */
export class TeamHierarchyCycle extends Schema.TaggedError<TeamHierarchyCycle>()(
  "TeamHierarchyCycle",
  {},
  { httpApiStatus: 409 },
) {}

/** OHS-001: a team that still has child teams cannot be removed. */
export class TeamHasChildren extends Schema.TaggedError<TeamHasChildren>()(
  "TeamHasChildren",
  {},
  { httpApiStatus: 409 },
) {}

export class TeamMembershipNotFound extends Schema.TaggedError<TeamMembershipNotFound>()(
  "TeamMembershipNotFound",
  {},
  { httpApiStatus: 404 },
) {}

// ---- schemas ------------------------------------------------------------------

export const CreateOrganizationPayload = Schema.Struct({
  name: Schema.String,
  slug: Schema.String,
  logo: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.String),
});
export type CreateOrganizationPayload = typeof CreateOrganizationPayload.Type;

export const UpdateOrganizationPayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  logo: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(Schema.NullOr(Schema.String)),
});
export type UpdateOrganizationPayload = typeof UpdateOrganizationPayload.Type;

export const UpdateMemberRolePayload = Schema.Struct({ role: Schema.Array(Schema.String) });
export type UpdateMemberRolePayload = typeof UpdateMemberRolePayload.Type;

export const OrganizationIdParams = Schema.Struct({ organizationId: Schema.String });
export type OrganizationIdParams = typeof OrganizationIdParams.Type;

export const MemberParams = Schema.Struct({ organizationId: Schema.String, userId: Schema.String });
export type MemberParams = typeof MemberParams.Type;

export const CheckSlugQuery = { slug: Schema.String };
export type CheckSlugQuery = { readonly slug: string };

export const GetFullQuery = {
  membersLimit: Schema.optional(Schema.String),
  membersOffset: Schema.optional(Schema.String),
};
export type GetFullQuery = {
  readonly membersLimit?: string | undefined;
  readonly membersOffset?: string | undefined;
};

export const ListMembersQuery = {
  limit: Schema.optional(Schema.String),
  offset: Schema.optional(Schema.String),
  sortDirection: Schema.optional(Schema.Literals(["asc", "desc"])),
};
export type ListMembersQuery = {
  readonly limit?: string | undefined;
  readonly offset?: string | undefined;
  readonly sortDirection?: "asc" | "desc" | undefined;
};

export class OrganizationDto extends Schema.Class<OrganizationDto>("OrganizationDto")({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  logo: Schema.NullOr(Schema.String),
  metadata: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
}) {}

export class MembershipDto extends Schema.Class<MembershipDto>("MembershipDto")({
  id: Schema.String,
  userId: Schema.String,
  organizationId: Schema.String,
  role: Schema.Array(Schema.String),
  createdAt: Schema.String,
}) {}

export class CheckSlugResult extends Schema.Class<CheckSlugResult>("CheckSlugResult")({
  available: Schema.Boolean,
}) {}

// ---- invitations --------------------------------------------------------------

export const InvitePayload = Schema.Struct({
  email: Schema.String,
  role: Schema.Array(Schema.String),
  teamId: Schema.optional(Schema.String),
  resend: Schema.optional(Schema.Boolean),
});
export type InvitePayload = typeof InvitePayload.Type;

export const InvitationIdParams = Schema.Struct({ invitationId: Schema.String });
export type InvitationIdParams = typeof InvitationIdParams.Type;

/** MTI-010: the emailed capability. The invitation id in the path is not the secret; accepting/rejecting needs this too. */
export const InvitationTokenPayload = Schema.Struct({ token: Schema.String });
export type InvitationTokenPayload = typeof InvitationTokenPayload.Type;

export const InvitationTokenParams = Schema.Struct({ token: Schema.String });
export type InvitationTokenParams = typeof InvitationTokenParams.Type;

export class InvitationDto extends Schema.Class<InvitationDto>("InvitationDto")({
  id: Schema.String,
  email: Schema.String,
  inviterId: Schema.String,
  organizationId: Schema.String,
  teamId: Schema.NullOr(Schema.String),
  role: Schema.Array(Schema.String),
  status: Schema.Literals(["pending", "accepted", "rejected", "canceled", "expired"]),
  createdAt: Schema.String,
  expiresAt: Schema.String,
}) {}

export class GetFullResult extends Schema.Class<GetFullResult>("GetFullResult")({
  organization: OrganizationDto,
  members: Schema.Array(MembershipDto),
  invitations: Schema.Array(InvitationDto),
}) {}

export class MemberRoleResult extends Schema.Class<MemberRoleResult>("MemberRoleResult")({
  role: Schema.Array(Schema.String),
}) {}

export const SetActivePayload = Schema.Struct({
  organizationId: Schema.NullOr(Schema.String),
});
export type SetActivePayload = typeof SetActivePayload.Type;

export class ActiveContextDto extends Schema.Class<ActiveContextDto>("ActiveContextDto")({
  activeOrganizationId: Schema.NullOr(Schema.String),
  activeTeamId: Schema.NullOr(Schema.String),
}) {}

// ---- dynamic access control -----------------------------------------------------

export const Permission = Schema.Record(Schema.String, Schema.Array(Schema.String));
export type Permission = typeof Permission.Type;

export const CreateOrgRolePayload = Schema.Struct({
  role: Schema.String,
  permission: Permission,
});
export type CreateOrgRolePayload = typeof CreateOrgRolePayload.Type;

export const UpdateOrgRolePayload = Schema.Struct({ permission: Permission });
export type UpdateOrgRolePayload = typeof UpdateOrgRolePayload.Type;

export const OrgRoleParams = Schema.Struct({
  organizationId: Schema.String,
  roleId: Schema.String,
});
export type OrgRoleParams = typeof OrgRoleParams.Type;

export class OrgRoleDto extends Schema.Class<OrgRoleDto>("OrgRoleDto")({
  id: Schema.String,
  organizationId: Schema.String,
  role: Schema.String,
  permission: Permission,
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

// ---- teams --------------------------------------------------------------------

export const CreateTeamPayload = Schema.Struct({
  name: Schema.String,
  /** OHS-001: create the team under this parent (same organization). */
  parentId: Schema.optional(Schema.String),
});
export type CreateTeamPayload = typeof CreateTeamPayload.Type;

export const UpdateTeamPayload = Schema.Struct({ name: Schema.String });
export type UpdateTeamPayload = typeof UpdateTeamPayload.Type;

/** OHS-001: `null` moves the team to the root. */
export const MoveTeamPayload = Schema.Struct({ parentId: Schema.NullOr(Schema.String) });
export type MoveTeamPayload = typeof MoveTeamPayload.Type;

export const TeamIdParams = Schema.Struct({
  organizationId: Schema.String,
  teamId: Schema.String,
});
export type TeamIdParams = typeof TeamIdParams.Type;

export const TeamMemberParams = Schema.Struct({
  organizationId: Schema.String,
  teamId: Schema.String,
  userId: Schema.String,
});
export type TeamMemberParams = typeof TeamMemberParams.Type;

export const AddTeamMemberPayload = Schema.Struct({ userId: Schema.String });
export type AddTeamMemberPayload = typeof AddTeamMemberPayload.Type;

export const SetActiveTeamPayload = Schema.Struct({ teamId: Schema.NullOr(Schema.String) });
export type SetActiveTeamPayload = typeof SetActiveTeamPayload.Type;

export class TeamDto extends Schema.Class<TeamDto>("TeamDto")({
  id: Schema.String,
  name: Schema.String,
  organizationId: Schema.String,
  memberCount: Schema.Number,
  /** OHS-001: `null` for a root team. */
  parentId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

export class TeamMembershipDto extends Schema.Class<TeamMembershipDto>("TeamMembershipDto")({
  id: Schema.String,
  teamId: Schema.String,
  userId: Schema.String,
  createdAt: Schema.String,
}) {}

// ---- group --------------------------------------------------------------------

export const OrganizationGroup = HttpApiGroup.make("organization")
  .add(
    HttpApiEndpoint.post("create", "/organization", {
      payload: CreateOrganizationPayload,
      success: OrganizationDto,
      error: [
        OrganizationSlugTaken,
        OrganizationCreationNotAllowed,
        OrganizationLimitReached,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("checkSlug", "/organization/check-slug", {
      query: CheckSlugQuery,
      success: CheckSlugResult,
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/organization", {
      success: Schema.Array(OrganizationDto),
    }),
  )
  .add(
    HttpApiEndpoint.post("setActive", "/organization/active", {
      payload: SetActivePayload,
      success: ActiveContextDto,
      error: MembershipNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("getActive", "/organization/active", {
      success: ActiveContextDto,
    }),
  )
  .add(
    HttpApiEndpoint.post("setActiveTeam", "/organization/active-team", {
      payload: SetActiveTeamPayload,
      success: ActiveContextDto,
      error: TeamMembershipNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("getActiveMember", "/organization/active-member", {
      success: MembershipDto,
      error: NoActiveOrganization,
    }),
  )
  .add(
    HttpApiEndpoint.get("getActiveMemberRole", "/organization/active-member/role", {
      success: MemberRoleResult,
      error: NoActiveOrganization,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/organization/:organizationId", {
      params: OrganizationIdParams,
      success: OrganizationDto,
      error: OrganizationNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("getFull", "/organization/:organizationId/full", {
      params: OrganizationIdParams,
      query: GetFullQuery,
      success: GetFullResult,
      error: [OrganizationNotFound, OrganizationPermissionDenied],
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/organization/:organizationId", {
      params: OrganizationIdParams,
      payload: UpdateOrganizationPayload,
      success: OrganizationDto,
      error: [
        OrganizationNotFound,
        OrganizationSlugTaken,
        OrganizationPermissionDenied,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.delete("delete", "/organization/:organizationId", {
      params: OrganizationIdParams,
      success: HttpApiSchema.Empty(204),
      error: [
        OrganizationNotFound,
        OrganizationPermissionDenied,
        OrganizationDeletionDisabled,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("listMembers", "/organization/:organizationId/members", {
      params: OrganizationIdParams,
      query: ListMembersQuery,
      success: Schema.Array(MembershipDto),
      error: [OrganizationNotFound, OrganizationPermissionDenied],
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeMember", "/organization/:organizationId/members/:userId", {
      params: MemberParams,
      success: HttpApiSchema.Empty(204),
      error: [
        OrganizationNotFound,
        MembershipNotFound,
        OrganizationPermissionDenied,
        OwnerInvariantViolation,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateMemberRole", "/organization/:organizationId/members/:userId", {
      params: MemberParams,
      payload: UpdateMemberRolePayload,
      success: MembershipDto,
      error: [
        OrganizationNotFound,
        MembershipNotFound,
        OrganizationPermissionDenied,
        OwnerInvariantViolation,
        RolePermissionEscalation,
        UnknownOrgRole,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("leave", "/organization/:organizationId/leave", {
      params: OrganizationIdParams,
      success: HttpApiSchema.Empty(204),
      error: [
        OrganizationNotFound,
        MembershipNotFound,
        OwnerInvariantViolation,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("invite", "/organization/:organizationId/invitations", {
      params: OrganizationIdParams,
      payload: InvitePayload,
      success: InvitationDto,
      error: [
        OrganizationNotFound,
        OrganizationPermissionDenied,
        InvitationLimitReached,
        MembershipLimitReached,
        AlreadyMember,
        TeamsDisabled,
        TeamNotFound,
        RolePermissionEscalation,
        UnknownOrgRole,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "listInvitationsForOrganization",
      "/organization/:organizationId/invitations",
      {
        params: OrganizationIdParams,
        success: Schema.Array(InvitationDto),
        error: [OrganizationNotFound, OrganizationPermissionDenied],
      },
    ),
  )
  .add(
    HttpApiEndpoint.get("listInvitationsForUser", "/organization/invitations", {
      success: Schema.Array(InvitationDto),
    }),
  )
  .add(
    HttpApiEndpoint.get("getInvitation", "/organization/invitations/:invitationId", {
      params: InvitationIdParams,
      success: InvitationDto,
      error: InvitationNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("getInvitationByToken", "/organization/invitations/by-token/:token", {
      params: InvitationTokenParams,
      success: InvitationDto,
      error: InvitationNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("acceptInvitation", "/organization/invitations/:invitationId/accept", {
      params: InvitationIdParams,
      payload: InvitationTokenPayload,
      success: MembershipDto,
      error: [
        InvitationNotFound,
        InvitationNotPending,
        InvitationExpired,
        InvitationEmailMismatch,
        MembershipLimitReached,
        AlreadyMember,
        EmailVerificationRequired,
        TeamMemberLimitReached,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("rejectInvitation", "/organization/invitations/:invitationId/reject", {
      params: InvitationIdParams,
      payload: InvitationTokenPayload,
      success: HttpApiSchema.Empty(204),
      error: [InvitationNotFound, InvitationNotPending, InvitationEmailMismatch, HookPoint.HookAborted],
    }),
  )
  .add(
    HttpApiEndpoint.post("cancelInvitation", "/organization/invitations/:invitationId/cancel", {
      params: InvitationIdParams,
      success: HttpApiSchema.Empty(204),
      error: [
        InvitationNotFound,
        InvitationNotPending,
        OrganizationPermissionDenied,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("createRole", "/organization/:organizationId/roles", {
      params: OrganizationIdParams,
      payload: CreateOrgRolePayload,
      success: OrgRoleDto,
      error: [
        OrganizationNotFound,
        DynamicAccessControlDisabled,
        OrganizationPermissionDenied,
        OrgRoleNameTaken,
        ReservedOrgRoleName,
        RolePermissionEscalation,
        RoleLimitReached,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("listRoles", "/organization/:organizationId/roles", {
      params: OrganizationIdParams,
      success: Schema.Array(OrgRoleDto),
      error: [OrganizationNotFound, DynamicAccessControlDisabled, OrganizationPermissionDenied],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRole", "/organization/:organizationId/roles/:roleId", {
      params: OrgRoleParams,
      success: OrgRoleDto,
      error: [
        OrganizationNotFound,
        DynamicAccessControlDisabled,
        OrganizationPermissionDenied,
        OrgRoleNotFound,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateRole", "/organization/:organizationId/roles/:roleId", {
      params: OrgRoleParams,
      payload: UpdateOrgRolePayload,
      success: OrgRoleDto,
      error: [
        OrganizationNotFound,
        DynamicAccessControlDisabled,
        OrganizationPermissionDenied,
        OrgRoleNotFound,
        RolePermissionEscalation,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteRole", "/organization/:organizationId/roles/:roleId", {
      params: OrgRoleParams,
      success: HttpApiSchema.Empty(204),
      error: [
        OrganizationNotFound,
        DynamicAccessControlDisabled,
        OrganizationPermissionDenied,
        OrgRoleNotFound,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("createTeam", "/organization/:organizationId/teams", {
      params: OrganizationIdParams,
      payload: CreateTeamPayload,
      success: TeamDto,
      error: [
        OrganizationNotFound,
        TeamsDisabled,
        OrganizationPermissionDenied,
        TeamNotFound,
        TeamLimitReached,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("listTeams", "/organization/:organizationId/teams", {
      params: OrganizationIdParams,
      success: Schema.Array(TeamDto),
      error: [OrganizationNotFound, TeamsDisabled, OrganizationPermissionDenied],
    }),
  )
  .add(
    HttpApiEndpoint.get("listUserTeams", "/organization/:organizationId/teams/mine", {
      params: OrganizationIdParams,
      success: Schema.Array(TeamDto),
      error: [OrganizationNotFound, TeamsDisabled],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateTeam", "/organization/:organizationId/teams/:teamId", {
      params: TeamIdParams,
      payload: UpdateTeamPayload,
      success: TeamDto,
      error: [
        OrganizationNotFound,
        TeamsDisabled,
        OrganizationPermissionDenied,
        TeamNotFound,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeTeam", "/organization/:organizationId/teams/:teamId", {
      params: TeamIdParams,
      success: HttpApiSchema.Empty(204),
      error: [
        OrganizationNotFound,
        TeamsDisabled,
        OrganizationPermissionDenied,
        TeamNotFound,
        LastTeamCannotBeRemoved,
        TeamHasChildren,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.patch("moveTeam", "/organization/:organizationId/teams/:teamId/parent", {
      params: TeamIdParams,
      payload: MoveTeamPayload,
      success: TeamDto,
      error: [
        OrganizationNotFound,
        TeamsDisabled,
        OrganizationPermissionDenied,
        TeamNotFound,
        TeamHierarchyCycle,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("listTeamAncestors", "/organization/:organizationId/teams/:teamId/ancestors", {
      params: TeamIdParams,
      success: Schema.Array(TeamDto),
      error: [OrganizationNotFound, TeamsDisabled, TeamNotFound, OrganizationPermissionDenied],
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "listTeamDescendants",
      "/organization/:organizationId/teams/:teamId/descendants",
      {
        params: TeamIdParams,
        success: Schema.Array(TeamDto),
        error: [OrganizationNotFound, TeamsDisabled, TeamNotFound, OrganizationPermissionDenied],
      },
    ),
  )
  .add(
    HttpApiEndpoint.get("listTeamMembers", "/organization/:organizationId/teams/:teamId/members", {
      params: TeamIdParams,
      success: Schema.Array(TeamMembershipDto),
      error: [OrganizationNotFound, TeamsDisabled, TeamNotFound, OrganizationPermissionDenied],
    }),
  )
  .add(
    HttpApiEndpoint.post("addTeamMember", "/organization/:organizationId/teams/:teamId/members", {
      params: TeamIdParams,
      payload: AddTeamMemberPayload,
      success: TeamMembershipDto,
      error: [
        OrganizationNotFound,
        TeamsDisabled,
        OrganizationPermissionDenied,
        TeamNotFound,
        MembershipNotFound,
        TeamMemberLimitReached,
        AlreadyTeamMember,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.delete(
      "removeTeamMember",
      "/organization/:organizationId/teams/:teamId/members/:userId",
      {
        params: TeamMemberParams,
        success: HttpApiSchema.Empty(204),
        error: [
          OrganizationNotFound,
          TeamsDisabled,
          OrganizationPermissionDenied,
          TeamNotFound,
          TeamMembershipNotFound,
          HookPoint.HookAborted,
        ],
      },
    ),
  )
  // See `@awthaq/api`'s `Session.ts`: `CsrfProtection` declared last so it
  // runs first.
  .middleware(Api.Authentication)
  .middleware(Api.CsrfProtection);

export const OrganizationApi = HttpApi.make("auth").add(OrganizationGroup);
