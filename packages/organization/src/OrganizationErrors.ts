// @awthaq/organization — OrganizationErrors
//
// The domain errors every organization module fails with. They are the wire-shaped
// `Schema.TaggedError`s the HTTP contract (`OrganizationApi.ts`) lists in its endpoints, kept in
// a leaf file so the system modules (`OrganizationTeams`, ...) never import the contract.
// `OrganizationApi` re-exports each by name, so `OrganizationApi.TeamNotFound` keeps working.

import * as Schema from "effect/Schema";

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

/** DRS-007: the `homeRegion` is not in `OrganizationConfig.regions`. */
export class UnknownRegion extends Schema.TaggedError<UnknownRegion>()(
  "UnknownRegion",
  { region: Schema.String },
  { httpApiStatus: 422 },
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

/**
 * EEM-002: the invitation is persisted (and stays pending) but its mail
 * could not be delivered. The inviter is authenticated, so unlike an
 * enumeration-uniform flow the failure is surfaced — the client retries by
 * re-inviting with `resend: true`.
 */
export class InvitationDeliveryFailed extends Schema.TaggedError<InvitationDeliveryFailed>()(
  "InvitationDeliveryFailed",
  { invitationId: Schema.String },
  { httpApiStatus: 502 },
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

/** OHS-004: a team role name that `OrganizationConfig.teamStatements` (plus the default `member`) does not define. */
export class UnknownTeamRole extends Schema.TaggedError<UnknownTeamRole>()(
  "UnknownTeamRole",
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
