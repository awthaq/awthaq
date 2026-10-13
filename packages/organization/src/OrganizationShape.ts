// @awthaq/organization — OrganizationShape
//
// The authorized interface: what a signed-in member calls through HTTP. A leaf file (the plugin
// class, its handlers and its implementation all import it) so the handlers never import the class.

import type { Api } from "@awthaq/api";
import type { Errors, HookPoint, Users } from "@awthaq/core";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as ActiveContextRecords from "./ActiveContextRecords.ts";
import type * as InvitationRecords from "./InvitationRecords.ts";
import type * as MembershipRecords from "./MembershipRecords.ts";
import type * as OrganizationApi from "./OrganizationApi.ts";
import type * as OrganizationRecords from "./OrganizationRecords.ts";
import type * as OrgRoleRecords from "./OrgRoleRecords.ts";
import type * as PermissionEngine from "./PermissionEngine.ts";
import type * as TeamRecords from "./TeamRecords.ts";

// ---- shape --------------------------------------------------------------------

export interface OrganizationShape {
  readonly create: (input: {
    readonly caller: Api.UserPrincipal;
    readonly name: string;
    readonly slug: string;
    readonly logo?: string | undefined;
    readonly metadata?: string | undefined;
    readonly homeRegion?: string | undefined;
  }) => Effect.Effect<
    OrganizationRecords.OrganizationRecord,
    | OrganizationApi.OrganizationSlugTaken
    | OrganizationApi.OrganizationCreationNotAllowed
    | OrganizationApi.OrganizationLimitReached
    | OrganizationApi.UnknownRegion
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly checkSlug: (slug: string) => Effect.Effect<boolean, Errors.StoreUnavailable>;
  readonly list: (
    caller: Api.UserPrincipal,
  ) => Effect.Effect<
    ReadonlyArray<OrganizationRecords.OrganizationRecord>,
    Errors.StoreUnavailable
  >;
  /** MTI-008: member-only — a non-member gets the same `OrganizationNotFound` an unknown id gets. */
  readonly get: (
    caller: Api.UserPrincipal,
    organizationId: string,
  ) => Effect.Effect<
    OrganizationRecords.OrganizationRecord,
    OrganizationApi.OrganizationNotFound | Errors.StoreUnavailable
  >;
  readonly getFull: (
    caller: Api.UserPrincipal,
    organizationId: string,
    input?: {
      readonly membersLimit?: number | undefined;
      readonly membersOffset?: number | undefined;
    },
  ) => Effect.Effect<
    {
      readonly organization: OrganizationRecords.OrganizationRecord;
      readonly members: ReadonlyArray<MembershipRecords.MembershipRecord>;
      readonly invitations: ReadonlyArray<InvitationRecords.InvitationRecord>;
    },
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.OrganizationPermissionDenied
    | Errors.StoreUnavailable
  >;
  readonly update: (
    caller: Api.UserPrincipal,
    organizationId: string,
    input: {
      readonly name?: string | undefined;
      readonly slug?: string | undefined;
      readonly logo?: string | null | undefined;
      readonly metadata?: string | null | undefined;
      readonly homeRegion?: string | null | undefined;
    },
  ) => Effect.Effect<
    OrganizationRecords.OrganizationRecord,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.OrganizationSlugTaken
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.UnknownRegion
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly delete: (
    caller: Api.UserPrincipal,
    organizationId: string,
  ) => Effect.Effect<
    void,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.OrganizationDeletionDisabled
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly listMembers: (
    caller: Api.UserPrincipal,
    organizationId: string,
    input?: MembershipRecords.ListMembersInput,
  ) => Effect.Effect<
    ReadonlyArray<MembershipRecords.MembershipRecord>,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.OrganizationPermissionDenied
    | Errors.StoreUnavailable
  >;
  readonly removeMember: (
    caller: Api.UserPrincipal,
    organizationId: string,
    targetUserId: Users.UserId,
  ) => Effect.Effect<
    void,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.MembershipNotFound
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.OwnerInvariantViolation
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly updateMemberRole: (
    caller: Api.UserPrincipal,
    organizationId: string,
    targetUserId: Users.UserId,
    role: ReadonlyArray<string>,
  ) => Effect.Effect<
    MembershipRecords.MembershipRecord,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.MembershipNotFound
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.OwnerInvariantViolation
    | OrganizationApi.RolePermissionEscalation
    | OrganizationApi.UnknownOrgRole
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly leave: (
    caller: Api.UserPrincipal,
    organizationId: string,
  ) => Effect.Effect<
    void,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.MembershipNotFound
    | OrganizationApi.OwnerInvariantViolation
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /** Server-only: no invitation round-trip, no HTTP endpoint — a trusted, app-driven direct add. */
  readonly addMember: (input: {
    readonly organizationId: string;
    readonly userId: Users.UserId;
    readonly role: ReadonlyArray<string>;
  }) => Effect.Effect<
    MembershipRecords.MembershipRecord,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.MembershipLimitReached
    | OrganizationApi.AlreadyMember
    | OrganizationApi.UnknownOrgRole
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /**
   * BEH-EA-316 (the SAML role mapping's guard, RRM-001's `canGrant` rule with a role ceiling standing in for the caller): why
   * `roles` cannot be conferred by a source whose most is `ceiling` (role names of this organization), or `None` when they
   * can. `unknownRole`/`unknownCeiling`: a name this organization does not recognize; `exceedsCeiling`: `roles` hold a
   * statement the ceiling does not (an `owner` mapping under a `member` ceiling).
   */
  readonly checkRoleCeiling: (input: {
    readonly organizationId: string;
    readonly roles: ReadonlyArray<string>;
    readonly ceiling: ReadonlyArray<string>;
  }) => Effect.Effect<
    Option.Option<"unknownRole" | "unknownCeiling" | "exceedsCeiling">,
    OrganizationApi.OrganizationNotFound | Errors.StoreUnavailable
  >;
  /**
   * BEH-EA-316: makes `userId`'s roles in the organization exactly `roles`, on behalf of a source (an identity provider's
   * mapping) that has no caller: adds the membership when there is none, otherwise re-roles it. `canGrant` bounds it twice:
   * `roles` must be within `ceiling`, and so must what the member holds now (a member who out-privileges the source is
   * never demoted or reshaped by it: `RolePermissionEscalation`). The last owner is never demoted
   * (`OwnerInvariantViolation`); limits, hooks and events are those of `addMember` / `updateMemberRole`.
   */
  readonly syncMemberRoles: (input: {
    readonly organizationId: string;
    readonly userId: Users.UserId;
    readonly roles: ReadonlyArray<string>;
    readonly ceiling: ReadonlyArray<string>;
  }) => Effect.Effect<
    {
      readonly membership: MembershipRecords.MembershipRecord;
      readonly change: "added" | "updated" | "unchanged";
    },
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.MembershipLimitReached
    | OrganizationApi.AlreadyMember
    | OrganizationApi.UnknownOrgRole
    | OrganizationApi.RolePermissionEscalation
    | OrganizationApi.OwnerInvariantViolation
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly getActiveMember: (
    caller: Api.UserPrincipal,
  ) => Effect.Effect<
    MembershipRecords.MembershipRecord,
    OrganizationApi.NoActiveOrganization | Errors.StoreUnavailable
  >;
  readonly getActiveMemberRole: (
    caller: Api.UserPrincipal,
  ) => Effect.Effect<
    ReadonlyArray<string>,
    OrganizationApi.NoActiveOrganization | Errors.StoreUnavailable
  >;
  /** Upserts the caller's own session's active organization; `organizationId: null` unsets it. Rejects if the caller isn't a member of the named organization. */
  readonly setActive: (
    caller: Api.UserPrincipal,
    organizationId: string | null,
  ) => Effect.Effect<
    ActiveContextRecords.ActiveContextRecord,
    OrganizationApi.MembershipNotFound | Errors.StoreUnavailable
  >;
  readonly getActive: (
    caller: Api.UserPrincipal,
  ) => Effect.Effect<ActiveContextRecords.ActiveContextRecord, Errors.StoreUnavailable>;
  readonly invite: (
    caller: Api.UserPrincipal,
    organizationId: string,
    input: {
      readonly email: string;
      readonly role: ReadonlyArray<string>;
      readonly teamId?: string | undefined;
      readonly resend?: boolean | undefined;
    },
  ) => Effect.Effect<
    InvitationRecords.InvitationRecord,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.InvitationLimitReached
    | OrganizationApi.InvitationDeliveryFailed
    | OrganizationApi.MembershipLimitReached
    | OrganizationApi.AlreadyMember
    | OrganizationApi.TeamsDisabled
    | OrganizationApi.TeamNotFound
    | OrganizationApi.RolePermissionEscalation
    | OrganizationApi.UnknownOrgRole
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /** MTI-010: `token` is the emailed capability; the invitation id alone accepts nothing. */
  readonly acceptInvitation: (
    caller: Api.UserPrincipal,
    invitationId: string,
    token: string,
  ) => Effect.Effect<
    MembershipRecords.MembershipRecord,
    | OrganizationApi.InvitationNotFound
    | OrganizationApi.InvitationNotPending
    | OrganizationApi.InvitationExpired
    | OrganizationApi.InvitationEmailMismatch
    | OrganizationApi.MembershipLimitReached
    | OrganizationApi.AlreadyMember
    | OrganizationApi.EmailVerificationRequired
    | OrganizationApi.TeamMemberLimitReached
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly rejectInvitation: (
    caller: Api.UserPrincipal,
    invitationId: string,
    token: string,
  ) => Effect.Effect<
    void,
    | OrganizationApi.InvitationNotFound
    | OrganizationApi.InvitationNotPending
    | OrganizationApi.InvitationEmailMismatch
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly cancelInvitation: (
    caller: Api.UserPrincipal,
    invitationId: string,
  ) => Effect.Effect<
    void,
    | OrganizationApi.InvitationNotFound
    | OrganizationApi.InvitationNotPending
    | OrganizationApi.OrganizationPermissionDenied
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /**
   * MTI-010: readable only by the invitee (email match) or a member holding
   * `invitation:create`; anyone else gets the same `InvitationNotFound` an unknown id gets.
   */
  readonly getInvitation: (
    caller: Api.UserPrincipal,
    invitationId: string,
  ) => Effect.Effect<
    InvitationRecords.InvitationRecord,
    OrganizationApi.InvitationNotFound | Errors.StoreUnavailable
  >;
  /** MTI-010: the landing-page lookup — resolves the emailed token, for the invitee only. */
  readonly getInvitationByToken: (
    caller: Api.UserPrincipal,
    token: string,
  ) => Effect.Effect<
    InvitationRecords.InvitationRecord,
    OrganizationApi.InvitationNotFound | Errors.StoreUnavailable
  >;
  readonly listInvitationsForOrganization: (
    caller: Api.UserPrincipal,
    organizationId: string,
  ) => Effect.Effect<
    ReadonlyArray<InvitationRecords.InvitationRecord>,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.OrganizationPermissionDenied
    | Errors.StoreUnavailable
  >;
  readonly listInvitationsForUser: (
    caller: Api.UserPrincipal,
  ) => Effect.Effect<ReadonlyArray<InvitationRecords.InvitationRecord>, Errors.StoreUnavailable>;
  readonly createRole: (
    caller: Api.UserPrincipal,
    organizationId: string,
    input: { readonly role: string; readonly permission: PermissionEngine.Statements },
  ) => Effect.Effect<
    OrgRoleRecords.OrgRoleRecord,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.DynamicAccessControlDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.OrgRoleNameTaken
    | OrganizationApi.ReservedOrgRoleName
    | OrganizationApi.RolePermissionEscalation
    | OrganizationApi.RoleLimitReached
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly listRoles: (
    caller: Api.UserPrincipal,
    organizationId: string,
  ) => Effect.Effect<
    ReadonlyArray<OrgRoleRecords.OrgRoleRecord>,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.DynamicAccessControlDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | Errors.StoreUnavailable
  >;
  readonly getRole: (
    caller: Api.UserPrincipal,
    organizationId: string,
    roleId: string,
  ) => Effect.Effect<
    OrgRoleRecords.OrgRoleRecord,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.DynamicAccessControlDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.OrgRoleNotFound
    | Errors.StoreUnavailable
  >;
  readonly updateRole: (
    caller: Api.UserPrincipal,
    organizationId: string,
    roleId: string,
    permission: PermissionEngine.Statements,
  ) => Effect.Effect<
    OrgRoleRecords.OrgRoleRecord,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.DynamicAccessControlDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.OrgRoleNotFound
    | OrganizationApi.RolePermissionEscalation
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly deleteRole: (
    caller: Api.UserPrincipal,
    organizationId: string,
    roleId: string,
  ) => Effect.Effect<
    void,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.DynamicAccessControlDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.OrgRoleNotFound
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /** OHS-001: with a `parentId`, the team is created under that parent (`TeamNotFound` when it is not in this organization). */
  readonly createTeam: (
    caller: Api.UserPrincipal,
    organizationId: string,
    name: string,
    parentId?: string | undefined,
  ) => Effect.Effect<
    TeamRecords.TeamRecord,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.TeamsDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.TeamNotFound
    | OrganizationApi.TeamLimitReached
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /** OHS-001: re-parents a team with its whole subtree; `None` moves it to the root. Needs `team:update`. */
  readonly moveTeam: (
    caller: Api.UserPrincipal,
    organizationId: string,
    teamId: string,
    parentId: Option.Option<string>,
  ) => Effect.Effect<
    TeamRecords.TeamRecord,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.TeamsDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.TeamNotFound
    | OrganizationApi.TeamHierarchyCycle
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /** OHS-001: member-only, nearest first. */
  readonly listTeamAncestors: (
    caller: Api.UserPrincipal,
    organizationId: string,
    teamId: string,
  ) => Effect.Effect<
    ReadonlyArray<TeamRecords.TeamRecord>,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.TeamsDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.TeamNotFound
    | Errors.StoreUnavailable
  >;
  /** OHS-001: member-only, nearest first. */
  readonly listTeamDescendants: (
    caller: Api.UserPrincipal,
    organizationId: string,
    teamId: string,
  ) => Effect.Effect<
    ReadonlyArray<TeamRecords.TeamRecord>,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.TeamsDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.TeamNotFound
    | Errors.StoreUnavailable
  >;
  /** MTI-002: member-only — a full team roster/directory is confidential to the organization, not deployment-public. */
  readonly listTeams: (
    caller: Api.UserPrincipal,
    organizationId: string,
  ) => Effect.Effect<
    ReadonlyArray<TeamRecords.TeamRecord>,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.TeamsDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | Errors.StoreUnavailable
  >;
  readonly listUserTeams: (
    caller: Api.UserPrincipal,
    organizationId: string,
  ) => Effect.Effect<
    ReadonlyArray<TeamRecords.TeamRecord>,
    OrganizationApi.OrganizationNotFound | OrganizationApi.TeamsDisabled | Errors.StoreUnavailable
  >;
  readonly updateTeam: (
    caller: Api.UserPrincipal,
    organizationId: string,
    teamId: string,
    name: string,
  ) => Effect.Effect<
    TeamRecords.TeamRecord,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.TeamsDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.TeamNotFound
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly removeTeam: (
    caller: Api.UserPrincipal,
    organizationId: string,
    teamId: string,
  ) => Effect.Effect<
    void,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.TeamsDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.TeamNotFound
    | OrganizationApi.LastTeamCannotBeRemoved
    | OrganizationApi.TeamHasChildren
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /** MTI-002: member-only — a team roster is personal data about the organization's own staff, not deployment-public. */
  readonly listTeamMembers: (
    caller: Api.UserPrincipal,
    organizationId: string,
    teamId: string,
  ) => Effect.Effect<
    ReadonlyArray<TeamRecords.TeamMembershipRecord>,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.TeamsDisabled
    | OrganizationApi.TeamNotFound
    | OrganizationApi.OrganizationPermissionDenied
    | Errors.StoreUnavailable
  >;
  readonly addTeamMember: (
    caller: Api.UserPrincipal,
    organizationId: string,
    teamId: string,
    targetUserId: Users.UserId,
    role?: ReadonlyArray<string> | undefined,
  ) => Effect.Effect<
    TeamRecords.TeamMembershipRecord,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.TeamsDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.TeamNotFound
    | OrganizationApi.MembershipNotFound
    | OrganizationApi.TeamMemberLimitReached
    | OrganizationApi.AlreadyTeamMember
    | OrganizationApi.RolePermissionEscalation
    | OrganizationApi.UnknownTeamRole
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /** OHS-004: needs `team:update` on the team (org-level, or a team role held on it or an ancestor); `canGrant`-guarded like org roles. */
  readonly updateTeamMemberRole: (
    caller: Api.UserPrincipal,
    organizationId: string,
    teamId: string,
    targetUserId: Users.UserId,
    role: ReadonlyArray<string>,
  ) => Effect.Effect<
    TeamRecords.TeamMembershipRecord,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.TeamsDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.TeamNotFound
    | OrganizationApi.TeamMembershipNotFound
    | OrganizationApi.RolePermissionEscalation
    | OrganizationApi.UnknownTeamRole
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly removeTeamMember: (
    caller: Api.UserPrincipal,
    organizationId: string,
    teamId: string,
    targetUserId: Users.UserId,
  ) => Effect.Effect<
    void,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.TeamsDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.TeamNotFound
    | OrganizationApi.TeamMembershipNotFound
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /** Upserts the caller's own session's active team; `teamId: null` unsets it. Rejects if the caller isn't a member of the named team. */
  readonly setActiveTeam: (
    caller: Api.UserPrincipal,
    teamId: string | null,
  ) => Effect.Effect<
    ActiveContextRecords.ActiveContextRecord,
    OrganizationApi.TeamMembershipNotFound | Errors.StoreUnavailable
  >;
  /**
   * A user's role(s) and effective permission set within an organization —
   * `Option.none` if they aren't a member. Not exposed over HTTP; exists so
   * `Organization.attributes` (this plugin's `AttributeResolver` contribution,
   * ticket 18) can answer from the same computation `requirePermission`
   * itself uses, rather than duplicating `statementsByRole`/
   * `effectivePermissionsOf`'s logic in a second place.
   */
  readonly attributesFor: (
    organizationId: string,
    userId: Users.UserId,
  ) => Effect.Effect<
    Option.Option<{
      readonly role: ReadonlyArray<string>;
      readonly permissions: PermissionEngine.Statements;
    }>,
    Errors.StoreUnavailable
  >;
}
