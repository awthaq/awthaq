// @awthaq/organization — Organization
//
// spec.md. `Auth.make([Organization])` composes: `dependsOn` is left unset
// on `AuthPlugin.layer` — `Users`/`AuthEvents` are core domain services this
// plugin's own `make` Effect simply `yield*`s directly, the same
// established convention `@awthaq/admin`'s own `Admin.ts` documents.
//
// This plugin never depends on `@awthaq/qadi` (stratum ordering,
// mirroring `Admin.ts`'s own header comment) — its own endpoint gating is
// entirely self-contained via `PermissionEngine.ts`, not a qadi round trip.
// Ticket 18 (a later phase) adds this plugin's own qadi `Layer`
// contributions (`Organization.relationships`/`Organization.attributes`)
// as a separate, additive export — this file does not need to anticipate
// their shape.

import { Api } from "@awthaq/api";
import {
  AuthEvents,
  AuthPlugin,
  DataExport,
  Erasure,
  HookPoint,
  Migrations,
  Users,
} from "@awthaq/core";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ActiveContextRecords from "./ActiveContextRecords.ts";
import * as InvitationRecords from "./InvitationRecords.ts";
import * as MembershipRecords from "./MembershipRecords.ts";
import * as OrganizationApi from "./OrganizationApi.ts";
import * as OrganizationHooks from "./OrganizationHooks.ts";
import * as OrganizationRecords from "./OrganizationRecords.ts";
import * as OrgRoleRecords from "./OrgRoleRecords.ts";
import * as PermissionEngine from "./PermissionEngine.ts";
import * as TeamRecords from "./TeamRecords.ts";

// ---- config -------------------------------------------------------------------

export interface OrganizationConfigShape {
  /** spec.md: role assigned to the creating user. */
  readonly creatorRole: "owner" | "admin";
  /** spec.md: fail-open by default — every caller may create an organization unless configured otherwise. */
  readonly allowUserToCreateOrganization: (userId: Users.UserId) => Effect.Effect<boolean>;
  /** Max organizations a single user may own (own = holds `owner` on it). `Infinity` = unlimited. */
  readonly organizationLimit: number;
  /** Max memberships per organization. */
  readonly membershipLimit: number;
  readonly disableOrganizationDeletion: boolean;
  /** Custom static roles an application layers on top of `PermissionEngine.defaultStatements`. */
  readonly permissionStatements: Readonly<Record<string, PermissionEngine.Statements>>;
  readonly dynamicAccessControl: {
    readonly enabled: boolean;
    readonly maximumRolesPerOrganization: number;
  };
  readonly teams: {
    readonly enabled: boolean;
    readonly maximumTeams: number;
    readonly maximumMembersPerTeam: number;
    readonly allowRemovingAllTeams: boolean;
  };
  /**
   * OHS-004: team-scoped roles a `TeamMembershipRecord` can hold, each mapped to
   * the `team` statements it confers on *that team and its descendants*, on top of
   * whatever the caller's organization roles already grant. `team:create` lets a
   * holder create child teams under the team, `team:update` rename/move it and
   * manage its roster and roles, `team:delete` remove it. `member` (no
   * statements) is always defined and is the default; the default `lead` may
   * update its team.
   */
  readonly teamStatements: Readonly<Record<string, PermissionEngine.Statements>>;
  readonly invitationExpiresIn: Duration.Duration;
  readonly invitationLimit: number;
  readonly cancelPendingInvitationsOnReInvite: boolean;
  readonly requireEmailVerificationOnInvitation: boolean;
}

const defaultOrganizationConfig: OrganizationConfigShape = {
  creatorRole: "owner",
  allowUserToCreateOrganization: () => Effect.succeed(true),
  organizationLimit: Number.POSITIVE_INFINITY,
  membershipLimit: 100,
  disableOrganizationDeletion: false,
  permissionStatements: {},
  dynamicAccessControl: { enabled: false, maximumRolesPerOrganization: Number.POSITIVE_INFINITY },
  teams: {
    enabled: false,
    maximumTeams: Number.POSITIVE_INFINITY,
    maximumMembersPerTeam: Number.POSITIVE_INFINITY,
    allowRemovingAllTeams: false,
  },
  teamStatements: { lead: { team: ["update"] } },
  invitationExpiresIn: Duration.hours(48),
  invitationLimit: 100,
  cancelPendingInvitationsOnReInvite: false,
  requireEmailVerificationOnInvitation: false,
};

export const OrganizationConfig: Context.Reference<OrganizationConfigShape> = Context.Reference(
  "awthaq/organization/Config",
  { defaultValue: () => defaultOrganizationConfig },
);

export const config = (partial: Partial<OrganizationConfigShape>) => {
  // RZS-005/N8: a static custom role may not redefine a built-in tier — fail
  // at layer build rather than silently ignoring (or honoring) the override.
  const reserved = Object.keys(partial.permissionStatements ?? {}).filter(
    PermissionEngine.isBuiltInRole,
  );
  return reserved.length > 0
    ? Layer.effect(
        OrganizationConfig,
        Effect.die(
          new Error(
            `awthaq: Organization.config permissionStatements may not redefine the built-in role(s): ${reserved.join(", ")}`,
          ),
        ),
      )
    : Layer.succeed(OrganizationConfig, { ...defaultOrganizationConfig, ...partial });
};

// ---- shape --------------------------------------------------------------------

export interface OrganizationShape {
  readonly create: (input: {
    readonly caller: Api.UserPrincipal;
    readonly name: string;
    readonly slug: string;
    readonly logo?: string | undefined;
    readonly metadata?: string | undefined;
  }) => Effect.Effect<
    OrganizationRecords.OrganizationRecord,
    | OrganizationApi.OrganizationSlugTaken
    | OrganizationApi.OrganizationCreationNotAllowed
    | OrganizationApi.OrganizationLimitReached
    | HookPoint.HookAborted
  >;
  readonly checkSlug: (slug: string) => Effect.Effect<boolean>;
  readonly list: (
    caller: Api.UserPrincipal,
  ) => Effect.Effect<ReadonlyArray<OrganizationRecords.OrganizationRecord>>;
  /** MTI-008: member-only — a non-member gets the same `OrganizationNotFound` an unknown id gets. */
  readonly get: (
    caller: Api.UserPrincipal,
    organizationId: string,
  ) => Effect.Effect<OrganizationRecords.OrganizationRecord, OrganizationApi.OrganizationNotFound>;
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
    OrganizationApi.OrganizationNotFound | OrganizationApi.OrganizationPermissionDenied
  >;
  readonly update: (
    caller: Api.UserPrincipal,
    organizationId: string,
    input: {
      readonly name?: string | undefined;
      readonly slug?: string | undefined;
      readonly logo?: string | null | undefined;
      readonly metadata?: string | null | undefined;
    },
  ) => Effect.Effect<
    OrganizationRecords.OrganizationRecord,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.OrganizationSlugTaken
    | OrganizationApi.OrganizationPermissionDenied
    | HookPoint.HookAborted
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
  >;
  readonly listMembers: (
    caller: Api.UserPrincipal,
    organizationId: string,
    input?: MembershipRecords.ListMembersInput,
  ) => Effect.Effect<
    ReadonlyArray<MembershipRecords.MembershipRecord>,
    OrganizationApi.OrganizationNotFound | OrganizationApi.OrganizationPermissionDenied
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
  >;
  readonly getActiveMember: (
    caller: Api.UserPrincipal,
  ) => Effect.Effect<MembershipRecords.MembershipRecord, OrganizationApi.NoActiveOrganization>;
  readonly getActiveMemberRole: (
    caller: Api.UserPrincipal,
  ) => Effect.Effect<ReadonlyArray<string>, OrganizationApi.NoActiveOrganization>;
  /** Upserts the caller's own session's active organization; `organizationId: null` unsets it. Rejects if the caller isn't a member of the named organization. */
  readonly setActive: (
    caller: Api.UserPrincipal,
    organizationId: string | null,
  ) => Effect.Effect<ActiveContextRecords.ActiveContextRecord, OrganizationApi.MembershipNotFound>;
  readonly getActive: (
    caller: Api.UserPrincipal,
  ) => Effect.Effect<ActiveContextRecords.ActiveContextRecord>;
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
  >;
  /**
   * MTI-010: readable only by the invitee (email match) or a member holding
   * `invitation:create`; anyone else gets the same `InvitationNotFound` an unknown id gets.
   */
  readonly getInvitation: (
    caller: Api.UserPrincipal,
    invitationId: string,
  ) => Effect.Effect<InvitationRecords.InvitationRecord, OrganizationApi.InvitationNotFound>;
  /** MTI-010: the landing-page lookup — resolves the emailed token, for the invitee only. */
  readonly getInvitationByToken: (
    caller: Api.UserPrincipal,
    token: string,
  ) => Effect.Effect<InvitationRecords.InvitationRecord, OrganizationApi.InvitationNotFound>;
  readonly listInvitationsForOrganization: (
    caller: Api.UserPrincipal,
    organizationId: string,
  ) => Effect.Effect<
    ReadonlyArray<InvitationRecords.InvitationRecord>,
    OrganizationApi.OrganizationNotFound | OrganizationApi.OrganizationPermissionDenied
  >;
  readonly listInvitationsForUser: (
    caller: Api.UserPrincipal,
  ) => Effect.Effect<ReadonlyArray<InvitationRecords.InvitationRecord>>;
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
  >;
  readonly listRoles: (
    caller: Api.UserPrincipal,
    organizationId: string,
  ) => Effect.Effect<
    ReadonlyArray<OrgRoleRecords.OrgRoleRecord>,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.DynamicAccessControlDisabled
    | OrganizationApi.OrganizationPermissionDenied
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
  >;
  readonly listUserTeams: (
    caller: Api.UserPrincipal,
    organizationId: string,
  ) => Effect.Effect<
    ReadonlyArray<TeamRecords.TeamRecord>,
    OrganizationApi.OrganizationNotFound | OrganizationApi.TeamsDisabled
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
  >;
  /** Upserts the caller's own session's active team; `teamId: null` unsets it. Rejects if the caller isn't a member of the named team. */
  readonly setActiveTeam: (
    caller: Api.UserPrincipal,
    teamId: string | null,
  ) => Effect.Effect<
    ActiveContextRecords.ActiveContextRecord,
    OrganizationApi.TeamMembershipNotFound
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
    }>
  >;
}

// ---- invitation token helpers ---------------------------------------------------

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * What a presented token's hash is compared against when no invitation (or no
 * stored hash) exists, so a miss does the same hash + compare work as a wrong
 * token for a real invitation. Never equals a real SHA-256 hex digest.
 */
const NO_INVITATION_TOKEN_HASH = "0".repeat(64);

/** Constant-time comparison of two equal-length hex digests (same shape as `Sessions.ts`'s). */
const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

// ---- dto mapping ----------------------------------------------------------------

const toOrganizationDto = (
  record: OrganizationRecords.OrganizationRecord,
): OrganizationApi.OrganizationDto =>
  new OrganizationApi.OrganizationDto({
    id: record.id,
    name: record.name,
    slug: record.slug,
    logo: Option.getOrNull(record.logo),
    metadata: Option.getOrNull(record.metadata),
    createdAt: DateTime.formatIso(record.createdAt),
  });

const toMembershipDto = (
  record: MembershipRecords.MembershipRecord,
): OrganizationApi.MembershipDto =>
  new OrganizationApi.MembershipDto({
    id: record.id,
    userId: record.userId,
    organizationId: record.organizationId,
    role: record.role,
    createdAt: DateTime.formatIso(record.createdAt),
  });

const toActiveContextDto = (
  record: ActiveContextRecords.ActiveContextRecord,
): OrganizationApi.ActiveContextDto =>
  new OrganizationApi.ActiveContextDto({
    activeOrganizationId: Option.getOrNull(record.activeOrganizationId),
    activeTeamId: Option.getOrNull(record.activeTeamId),
  });

const toInvitationDto = (
  record: InvitationRecords.InvitationRecord,
): OrganizationApi.InvitationDto =>
  new OrganizationApi.InvitationDto({
    id: record.id,
    email: record.email,
    inviterId: record.inviterId,
    organizationId: record.organizationId,
    teamId: Option.getOrNull(record.teamId),
    role: record.role,
    status: record.status,
    createdAt: DateTime.formatIso(record.createdAt),
    expiresAt: DateTime.formatIso(record.expiresAt),
  });

const toOrgRoleDto = (record: OrgRoleRecords.OrgRoleRecord): OrganizationApi.OrgRoleDto =>
  new OrganizationApi.OrgRoleDto({
    id: record.id,
    organizationId: record.organizationId,
    role: record.role,
    permission: record.permission,
    createdAt: DateTime.formatIso(record.createdAt),
    updatedAt: DateTime.formatIso(record.updatedAt),
  });

const toTeamDto = (record: TeamRecords.TeamRecord): OrganizationApi.TeamDto =>
  new OrganizationApi.TeamDto({
    id: record.id,
    name: record.name,
    organizationId: record.organizationId,
    memberCount: record.memberCount,
    parentId: Option.getOrNull(record.parentId),
    createdAt: DateTime.formatIso(record.createdAt),
    updatedAt: DateTime.formatIso(record.updatedAt),
  });

const toTeamMembershipDto = (
  record: TeamRecords.TeamMembershipRecord,
): OrganizationApi.TeamMembershipDto =>
  new OrganizationApi.TeamMembershipDto({
    id: record.id,
    teamId: record.teamId,
    userId: record.userId,
    role: record.role,
    createdAt: DateTime.formatIso(record.createdAt),
  });

const currentUserPrincipal = Effect.gen(function* () {
  const principal = yield* Api.CurrentPrincipal;
  if (principal._tag !== "User") {
    return yield* Effect.die(
      new Error(`awthaq: organization group reached with a non-User principal: ${principal._tag}`),
    );
  }
  return principal;
});

const parseIntQuery = (value: string | undefined): number | undefined =>
  value === undefined ? undefined : Number.parseInt(value, 10);

// ---- handlers -------------------------------------------------------------------

export const OrganizationHandlers = HttpApiBuilder.group(
  OrganizationApi.OrganizationApi,
  "organization",
  Effect.fnUntraced(function* (handlers) {
    const organization = yield* Organization;
    return handlers.handleAll({
      create: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: OrganizationApi.CreateOrganizationPayload;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.create({ caller, ...payload });
        return toOrganizationDto(record);
      }),
      checkSlug: Effect.fnUntraced(function* ({
        query,
      }: {
        query: OrganizationApi.CheckSlugQuery;
      }) {
        const available = yield* organization.checkSlug(query.slug);
        return new OrganizationApi.CheckSlugResult({ available });
      }),
      list: Effect.fnUntraced(function* () {
        const caller = yield* currentUserPrincipal;
        const records = yield* organization.list(caller);
        return records.map(toOrganizationDto);
      }),
      setActive: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: OrganizationApi.SetActivePayload;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.setActive(caller, payload.organizationId);
        return toActiveContextDto(record);
      }),
      getActive: Effect.fnUntraced(function* () {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.getActive(caller);
        return toActiveContextDto(record);
      }),
      setActiveTeam: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: OrganizationApi.SetActiveTeamPayload;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.setActiveTeam(caller, payload.teamId);
        return toActiveContextDto(record);
      }),
      getActiveMember: Effect.fnUntraced(function* () {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.getActiveMember(caller);
        return toMembershipDto(record);
      }),
      getActiveMemberRole: Effect.fnUntraced(function* () {
        const caller = yield* currentUserPrincipal;
        const role = yield* organization.getActiveMemberRole(caller);
        return new OrganizationApi.MemberRoleResult({ role });
      }),
      get: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.OrganizationIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.get(caller, params.organizationId);
        return toOrganizationDto(record);
      }),
      getFull: Effect.fnUntraced(function* ({
        params,
        query,
      }: {
        params: OrganizationApi.OrganizationIdParams;
        query: OrganizationApi.GetFullQuery;
      }) {
        const caller = yield* currentUserPrincipal;
        const result = yield* organization.getFull(caller, params.organizationId, {
          membersLimit: parseIntQuery(query.membersLimit),
          membersOffset: parseIntQuery(query.membersOffset),
        });
        return new OrganizationApi.GetFullResult({
          organization: toOrganizationDto(result.organization),
          members: result.members.map(toMembershipDto),
          invitations: result.invitations.map(toInvitationDto),
        });
      }),
      update: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: OrganizationApi.OrganizationIdParams;
        payload: OrganizationApi.UpdateOrganizationPayload;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.update(caller, params.organizationId, payload);
        return toOrganizationDto(record);
      }),
      delete: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.OrganizationIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        yield* organization.delete(caller, params.organizationId);
      }),
      listMembers: Effect.fnUntraced(function* ({
        params,
        query,
      }: {
        params: OrganizationApi.OrganizationIdParams;
        query: OrganizationApi.ListMembersQuery;
      }) {
        const caller = yield* currentUserPrincipal;
        const records = yield* organization.listMembers(caller, params.organizationId, {
          limit: parseIntQuery(query.limit),
          offset: parseIntQuery(query.offset),
          sortDirection: query.sortDirection,
        });
        return records.map(toMembershipDto);
      }),
      removeMember: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.MemberParams;
      }) {
        const caller = yield* currentUserPrincipal;
        yield* organization.removeMember(
          caller,
          params.organizationId,
          Users.UserId(params.userId),
        );
      }),
      updateMemberRole: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: OrganizationApi.MemberParams;
        payload: OrganizationApi.UpdateMemberRolePayload;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.updateMemberRole(
          caller,
          params.organizationId,
          Users.UserId(params.userId),
          payload.role,
        );
        return toMembershipDto(record);
      }),
      leave: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.OrganizationIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        yield* organization.leave(caller, params.organizationId);
      }),
      invite: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: OrganizationApi.OrganizationIdParams;
        payload: OrganizationApi.InvitePayload;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.invite(caller, params.organizationId, payload);
        return toInvitationDto(record);
      }),
      listInvitationsForOrganization: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.OrganizationIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        const records = yield* organization.listInvitationsForOrganization(
          caller,
          params.organizationId,
        );
        return records.map(toInvitationDto);
      }),
      listInvitationsForUser: Effect.fnUntraced(function* () {
        const caller = yield* currentUserPrincipal;
        const records = yield* organization.listInvitationsForUser(caller);
        return records.map(toInvitationDto);
      }),
      getInvitation: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.InvitationIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.getInvitation(caller, params.invitationId);
        return toInvitationDto(record);
      }),
      getInvitationByToken: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.InvitationTokenParams;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.getInvitationByToken(caller, params.token);
        return toInvitationDto(record);
      }),
      acceptInvitation: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: OrganizationApi.InvitationIdParams;
        payload: OrganizationApi.InvitationTokenPayload;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.acceptInvitation(
          caller,
          params.invitationId,
          payload.token,
        );
        return toMembershipDto(record);
      }),
      rejectInvitation: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: OrganizationApi.InvitationIdParams;
        payload: OrganizationApi.InvitationTokenPayload;
      }) {
        const caller = yield* currentUserPrincipal;
        yield* organization.rejectInvitation(caller, params.invitationId, payload.token);
      }),
      cancelInvitation: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.InvitationIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        yield* organization.cancelInvitation(caller, params.invitationId);
      }),
      createRole: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: OrganizationApi.OrganizationIdParams;
        payload: OrganizationApi.CreateOrgRolePayload;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.createRole(caller, params.organizationId, payload);
        return toOrgRoleDto(record);
      }),
      listRoles: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.OrganizationIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        const records = yield* organization.listRoles(caller, params.organizationId);
        return records.map(toOrgRoleDto);
      }),
      getRole: Effect.fnUntraced(function* ({ params }: { params: OrganizationApi.OrgRoleParams }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.getRole(caller, params.organizationId, params.roleId);
        return toOrgRoleDto(record);
      }),
      updateRole: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: OrganizationApi.OrgRoleParams;
        payload: OrganizationApi.UpdateOrgRolePayload;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.updateRole(
          caller,
          params.organizationId,
          params.roleId,
          payload.permission,
        );
        return toOrgRoleDto(record);
      }),
      deleteRole: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.OrgRoleParams;
      }) {
        const caller = yield* currentUserPrincipal;
        yield* organization.deleteRole(caller, params.organizationId, params.roleId);
      }),
      createTeam: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: OrganizationApi.OrganizationIdParams;
        payload: OrganizationApi.CreateTeamPayload;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.createTeam(
          caller,
          params.organizationId,
          payload.name,
          payload.parentId,
        );
        return toTeamDto(record);
      }),
      moveTeam: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: OrganizationApi.TeamIdParams;
        payload: OrganizationApi.MoveTeamPayload;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.moveTeam(
          caller,
          params.organizationId,
          params.teamId,
          Option.fromNullOr(payload.parentId),
        );
        return toTeamDto(record);
      }),
      listTeamAncestors: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.TeamIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        const records = yield* organization.listTeamAncestors(
          caller,
          params.organizationId,
          params.teamId,
        );
        return records.map(toTeamDto);
      }),
      listTeamDescendants: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.TeamIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        const records = yield* organization.listTeamDescendants(
          caller,
          params.organizationId,
          params.teamId,
        );
        return records.map(toTeamDto);
      }),
      listTeams: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.OrganizationIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        const records = yield* organization.listTeams(caller, params.organizationId);
        return records.map(toTeamDto);
      }),
      listUserTeams: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.OrganizationIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        const records = yield* organization.listUserTeams(caller, params.organizationId);
        return records.map(toTeamDto);
      }),
      updateTeam: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: OrganizationApi.TeamIdParams;
        payload: OrganizationApi.UpdateTeamPayload;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.updateTeam(
          caller,
          params.organizationId,
          params.teamId,
          payload.name,
        );
        return toTeamDto(record);
      }),
      removeTeam: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.TeamIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        yield* organization.removeTeam(caller, params.organizationId, params.teamId);
      }),
      listTeamMembers: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.TeamIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        const records = yield* organization.listTeamMembers(
          caller,
          params.organizationId,
          params.teamId,
        );
        return records.map(toTeamMembershipDto);
      }),
      addTeamMember: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: OrganizationApi.TeamIdParams;
        payload: OrganizationApi.AddTeamMemberPayload;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.addTeamMember(
          caller,
          params.organizationId,
          params.teamId,
          Users.UserId(payload.userId),
          payload.role,
        );
        return toTeamMembershipDto(record);
      }),
      updateTeamMemberRole: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: OrganizationApi.TeamMemberParams;
        payload: OrganizationApi.UpdateTeamMemberRolePayload;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.updateTeamMemberRole(
          caller,
          params.organizationId,
          params.teamId,
          Users.UserId(params.userId),
          payload.role,
        );
        return toTeamMembershipDto(record);
      }),
      removeTeamMember: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.TeamMemberParams;
      }) {
        const caller = yield* currentUserPrincipal;
        yield* organization.removeTeamMember(
          caller,
          params.organizationId,
          params.teamId,
          Users.UserId(params.userId),
        );
      }),
    });
  }),
);

// ---- migrations -------------------------------------------------------------------

/**
 * BAM-002 (.issues/high): no plugin populated `migrations` before AOMS-006's
 * cluster resolution added `@awthaq/jwt`'s own — this plugin's 7 tables are
 * the largest remaining gap the finding named. Ported verbatim from each
 * `*Records.test.ts`'s own inline `CREATE TABLE` (every table's canonical,
 * already-working shape — `OrganizationRecords.test.ts`,
 * `MembershipRecords.test.ts`, `InvitationRecords.test.ts`,
 * `TeamRecords.test.ts`, `ActiveContextRecords.test.ts`,
 * `OrgRoleRecords.test.ts`), dialect-branched via `sql.onDialectOrElse`
 * like `@awthaq/sql`'s own `CoreMigrations.ts`. Columns left unquoted under
 * `pg` (unlike `CoreMigrations.ts`'s own `users`/`sessions` tables, like
 * `@awthaq/jwt`'s own `jwtMigrations`): every one of this plugin's own
 * queries already references every column unquoted, so Postgres's
 * automatic lowercase-folding is what keeps migration and query consistent
 * here. `organization_role`'s `UNIQUE(organizationId, role)` and
 * `organization_org.slug UNIQUE` are ported as-is from their own test
 * fixtures. The first eleven migrations are exactly that DDL parity
 * (BAM-002's own ask, not a fresh constraint audit); everything after them
 * is an incremental, never-edited-after-shipping change — MTI-003/OHS-003's
 * `(userId, organizationId)` and `(teamId, userId)` UNIQUE indexes (each
 * collapsing pre-existing duplicates first) and the later column additions.
 * `organizationId`/`userId`/`teamId`/`email`/`inviterId` indexes mirror
 * `CoreMigrations.ts`'s own `accounts_user_id`/`sessions_user_id`
 * precedent: added only where a column is a real, independent filter key
 * in this plugin's own queries (grep for `WHERE <col> =` across
 * `*Records.ts`) and not already covered by a composite UNIQUE's leftmost
 * column (`organization_role`'s own `UNIQUE(organizationId, role)` already
 * serves `WHERE organizationId = ...` lookups, so it gets no separate
 * index; `organization_active_context`'s own `sessionId` primary key
 * likewise needs none).
 */
const organizationMigrations: Migrations.Migrations = [
  {
    name: "create_organization_org",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE organization_org (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            logo TEXT,
            metadata TEXT,
            "createdAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_org (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            logo TEXT,
            metadata TEXT,
            "createdAt" TEXT NOT NULL
          )`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
  {
    name: "create_organization_membership",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE organization_membership (
            id TEXT PRIMARY KEY,
            "userId" TEXT NOT NULL,
            "organizationId" TEXT NOT NULL,
            role TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_membership (
            id TEXT PRIMARY KEY,
            "userId" TEXT NOT NULL,
            "organizationId" TEXT NOT NULL,
            role TEXT NOT NULL,
            "createdAt" TEXT NOT NULL
          )`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
  {
    name: "create_organization_membership_indexes",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () =>
          sql`CREATE INDEX organization_membership_organization_id ON organization_membership("organizationId")`.pipe(
            Effect.andThen(
              sql`CREATE INDEX organization_membership_user_id ON organization_membership("userId")`,
            ),
          ),
        sqlite: () =>
          sql`CREATE INDEX organization_membership_organization_id ON organization_membership("organizationId")`.pipe(
            Effect.andThen(
              sql`CREATE INDEX organization_membership_user_id ON organization_membership("userId")`,
            ),
          ),
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
  {
    name: "create_organization_invitation",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE organization_invitation (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            "inviterId" TEXT NOT NULL,
            "organizationId" TEXT NOT NULL,
            "teamId" TEXT,
            role TEXT NOT NULL,
            status TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "expiresAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_invitation (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            "inviterId" TEXT NOT NULL,
            "organizationId" TEXT NOT NULL,
            "teamId" TEXT,
            role TEXT NOT NULL,
            status TEXT NOT NULL,
            "createdAt" TEXT NOT NULL,
            "expiresAt" TEXT NOT NULL
          )`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
  {
    name: "create_organization_invitation_indexes",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () =>
          sql`CREATE INDEX organization_invitation_organization_id ON organization_invitation("organizationId")`.pipe(
            Effect.andThen(
              sql`CREATE INDEX organization_invitation_email ON organization_invitation(email)`,
            ),
            Effect.andThen(
              sql`CREATE INDEX organization_invitation_inviter_id ON organization_invitation("inviterId")`,
            ),
          ),
        sqlite: () =>
          sql`CREATE INDEX organization_invitation_organization_id ON organization_invitation("organizationId")`.pipe(
            Effect.andThen(
              sql`CREATE INDEX organization_invitation_email ON organization_invitation(email)`,
            ),
            Effect.andThen(
              sql`CREATE INDEX organization_invitation_inviter_id ON organization_invitation("inviterId")`,
            ),
          ),
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
  {
    name: "create_organization_team",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE organization_team (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            "organizationId" TEXT NOT NULL,
            "memberCount" INTEGER NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "updatedAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_team (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            "organizationId" TEXT NOT NULL,
            "memberCount" INTEGER NOT NULL,
            "createdAt" TEXT NOT NULL,
            "updatedAt" TEXT NOT NULL
          )`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
  {
    name: "create_organization_team_organization_id_index",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () =>
          sql`CREATE INDEX organization_team_organization_id ON organization_team("organizationId")`,
        sqlite: () =>
          sql`CREATE INDEX organization_team_organization_id ON organization_team("organizationId")`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
  {
    name: "create_organization_team_membership",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE organization_team_membership (
            id TEXT PRIMARY KEY,
            "teamId" TEXT NOT NULL,
            "userId" TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_team_membership (
            id TEXT PRIMARY KEY,
            "teamId" TEXT NOT NULL,
            "userId" TEXT NOT NULL,
            "createdAt" TEXT NOT NULL
          )`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
  {
    name: "create_organization_team_membership_team_id_index",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () =>
          sql`CREATE INDEX organization_team_membership_team_id ON organization_team_membership("teamId")`,
        sqlite: () =>
          sql`CREATE INDEX organization_team_membership_team_id ON organization_team_membership("teamId")`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
  {
    name: "create_organization_role",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE organization_role (
            id TEXT PRIMARY KEY,
            "organizationId" TEXT NOT NULL,
            role TEXT NOT NULL,
            permission TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "updatedAt" TIMESTAMPTZ NOT NULL,
            UNIQUE("organizationId", role)
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_role (
            id TEXT PRIMARY KEY,
            "organizationId" TEXT NOT NULL,
            role TEXT NOT NULL,
            permission TEXT NOT NULL,
            "createdAt" TEXT NOT NULL,
            "updatedAt" TEXT NOT NULL,
            UNIQUE("organizationId", role)
          )`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
  {
    name: "create_organization_active_context",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE organization_active_context (
            "sessionId" TEXT PRIMARY KEY,
            "activeOrganizationId" TEXT,
            "activeTeamId" TEXT,
            "updatedAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_active_context (
            "sessionId" TEXT PRIMARY KEY,
            "activeOrganizationId" TEXT,
            "activeTeamId" TEXT,
            "updatedAt" TEXT NOT NULL
          )`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
  // MTI-003: one membership per (user, organization). The statements are plain
  // SQL both dialects share, so no `onDialectOrElse`. Duplicates that already
  // exist are collapsed first (keeping the earliest row — uuidv7 ids sort by
  // creation time) so the index can be created on live data.
  {
    name: "organization_membership_unique_user_org",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM organization_membership WHERE id NOT IN (SELECT MIN(id) FROM organization_membership GROUP BY "userId", "organizationId")`;
      yield* sql`CREATE UNIQUE INDEX organization_membership_user_org ON organization_membership("userId", "organizationId")`;
    }),
  },
  // DRS-008: the active-context row is keyed by session but must be findable by
  // user (erasure, membership revocation). Nullable: rows that predate it stay
  // valid and are re-validated on read.
  {
    name: "organization_active_context_user_id",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE organization_active_context ADD COLUMN "userId" TEXT`;
      yield* sql`CREATE INDEX organization_active_context_user_id ON organization_active_context("userId")`;
    }),
  },
  // MTI-010: the emailed invitation capability is a random token, stored only as
  // its SHA-256; the invitation's own id is no longer the secret. Nullable so
  // rows written before this column stay readable (they cannot be accepted).
  {
    name: "organization_invitation_token_hash",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE organization_invitation ADD COLUMN "tokenHash" TEXT`;
      yield* sql`CREATE UNIQUE INDEX organization_invitation_token_hash ON organization_invitation("tokenHash")`;
    }),
  },
  // OHS-003: one membership per (team, user), and `memberCount` recomputed from
  // the surviving rows so a previously over-counted team is repaired.
  {
    name: "organization_team_membership_unique_team_user",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM organization_team_membership WHERE id NOT IN (SELECT MIN(id) FROM organization_team_membership GROUP BY "teamId", "userId")`;
      yield* sql`UPDATE organization_team SET "memberCount" = (SELECT COUNT(*) FROM organization_team_membership WHERE organization_team_membership."teamId" = organization_team.id)`;
      yield* sql`CREATE UNIQUE INDEX organization_team_membership_team_user ON organization_team_membership("teamId", "userId")`;
    }),
  },
  // OHS-004: a team membership carries team-scoped role names (JSON array, like
  // `organization_membership.role`); every existing row is a plain `member`.
  {
    name: "organization_team_membership_role",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE organization_team_membership ADD COLUMN role TEXT NOT NULL DEFAULT '["member"]'`;
    }),
  },
  // OHS-001 (wayfinder ticket 34): a team may sit under one parent. `parentId` is
  // the write-side adjacency; `organization_team_closure` is the read model — one
  // row per (ancestor, descendant) pair, self rows at depth 0 — so ancestors and
  // descendants are single indexed lookups on both dialects with no recursive CTE.
  // No foreign keys, like every other table here: TeamRecords maintains both in
  // one transaction. Every existing team gets its self row.
  {
    name: "organization_team_hierarchy",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE organization_team ADD COLUMN "parentId" TEXT`;
      yield* sql`CREATE INDEX organization_team_parent_id ON organization_team("parentId")`;
      yield* sql`
        CREATE TABLE organization_team_closure (
          "ancestorId" TEXT NOT NULL,
          "descendantId" TEXT NOT NULL,
          depth INTEGER NOT NULL,
          PRIMARY KEY ("ancestorId", "descendantId")
        )`;
      yield* sql`CREATE INDEX organization_team_closure_descendant_id ON organization_team_closure("descendantId")`;
      yield* sql`INSERT INTO organization_team_closure ("ancestorId", "descendantId", depth) SELECT id, id, 0 FROM organization_team`;
    }),
  },
];

// ---- erasure --------------------------------------------------------------------

/**
 * CSG-001/DRS-002 (.issues/high), wayfinder ticket 30: this plugin's part of
 * `AccountErasure.eraseAccount`, part of `Organization.layer` itself (it requires
 * `Erasure.ErasureRegistry`, so a composition without one does not compile). It
 * removes every row that names the erased user: their memberships, their team
 * memberships (`memberCount`s decremented), the invitations they sent or that
 * were addressed to their email (the row holds it in plaintext), and their
 * active-context rows (DRS-008). It runs inside `eraseAccount`'s transaction.
 */
export const organizationErasure = Erasure.contribute({
  id: "organization",
  make: Effect.gen(function* () {
    const members = yield* MembershipRecords.MembershipRecords;
    const teams = yield* TeamRecords.TeamRecords;
    const invitations = yield* InvitationRecords.InvitationRecords;
    const activeContext = yield* ActiveContextRecords.ActiveContextRecords;
    return (subject: Erasure.ErasureSubject) =>
      Effect.all(
        [
          teams.removeUserFromAllTeams(subject.userId),
          members.deleteAllByUser(subject.userId),
          activeContext.deleteAllByUser(subject.userId),
          invitations.removeAllForUser(subject.userId, subject.email),
        ],
        { discard: true },
      );
  }),
});

/**
 * CSG-005: this plugin's section of the data-subject export — the organizations the person
 * belongs to and their role in each, the teams they are on, and the invitations they sent
 * or received. An invitation carries no third party's address (the invitee's email is
 * their data, not the subject's), and a role is a name, never a permission secret.
 */
export const organizationExport = DataExport.contribute({
  id: "organization",
  make: Effect.gen(function* () {
    const members = yield* MembershipRecords.MembershipRecords;
    const teams = yield* TeamRecords.TeamRecords;
    const invitations = yield* InvitationRecords.InvitationRecords;
    const invitationView = (row: InvitationRecords.InvitationRecord) => ({
      organizationId: row.organizationId,
      role: [...row.role],
      status: row.status,
      createdAt: DateTime.formatIso(row.createdAt),
      expiresAt: DateTime.formatIso(row.expiresAt),
    });
    return (subject: DataExport.DataExportSubject) =>
      Effect.gen(function* () {
        const memberships = yield* members.listByUser(subject.userId);
        const teamRows = yield* Effect.forEach(memberships, (membership) =>
          teams.listTeamsByUser(membership.organizationId, subject.userId),
        );
        return {
          memberships: memberships.map((membership) => ({
            organizationId: membership.organizationId,
            role: [...membership.role],
            createdAt: DateTime.formatIso(membership.createdAt),
          })),
          teams: teamRows.flat().map((team) => ({
            id: team.id,
            organizationId: team.organizationId,
            name: team.name,
          })),
          invitationsSent: (yield* invitations.listByInviter(subject.userId)).map(invitationView),
          invitationsReceived: (yield* invitations.listByEmail(subject.email)).map(invitationView),
        };
      });
  }),
});

// ---- plugin ---------------------------------------------------------------------

export class Organization extends AuthPlugin.Service<Organization, OrganizationShape>()(
  "organization",
  {
    apiVersion: 1,
    contract: OrganizationApi.OrganizationApi,
    migrations: organizationMigrations,
    tables: [
      "organization_org",
      "organization_membership",
      "organization_invitation",
      "organization_team",
      "organization_team_membership",
      "organization_team_closure",
      "organization_role",
      "organization_active_context",
    ],
  },
) {
  static readonly layer = AuthPlugin.layer(Organization, {
    handlers: OrganizationHandlers,
    contributes: Layer.mergeAll(organizationErasure, organizationExport),
    make: Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const orgs = yield* OrganizationRecords.OrganizationRecords;
      const members = yield* MembershipRecords.MembershipRecords;
      const activeContext = yield* ActiveContextRecords.ActiveContextRecords;
      const invitations = yield* InvitationRecords.InvitationRecords;
      const orgRoles = yield* OrgRoleRecords.OrgRoleRecords;
      const teams = yield* TeamRecords.TeamRecords;
      const users = yield* Users.Users;
      const mailer = yield* Mailer.Mailer;
      // OHS-002: the cascades below commit or roll back as one unit. `layerNoop`
      // for an in-memory composition, `layerSql` over the real client otherwise.
      const sqlTransaction = yield* SqlTransaction.SqlTransaction;
      const crypto = yield* Crypto.Crypto;
      const orgConfig = yield* OrganizationConfig;
      const beforeCreate = yield* OrganizationHooks.BeforeCreateOrganization;
      const afterCreate = yield* OrganizationHooks.AfterCreateOrganization;
      const beforeUpdate = yield* OrganizationHooks.BeforeUpdateOrganization;
      const afterUpdate = yield* OrganizationHooks.AfterUpdateOrganization;
      const beforeDelete = yield* OrganizationHooks.BeforeDeleteOrganization;
      const afterDelete = yield* OrganizationHooks.AfterDeleteOrganization;
      const beforeRemove = yield* OrganizationHooks.BeforeRemoveMember;
      const afterRemove = yield* OrganizationHooks.AfterRemoveMember;
      const beforeUpdateRole = yield* OrganizationHooks.BeforeUpdateMemberRole;
      const afterUpdateRole = yield* OrganizationHooks.AfterUpdateMemberRole;
      const beforeAdd = yield* OrganizationHooks.BeforeAddMember;
      const afterAdd = yield* OrganizationHooks.AfterAddMember;
      const beforeCreateInvitation = yield* OrganizationHooks.BeforeCreateInvitation;
      const afterCreateInvitation = yield* OrganizationHooks.AfterCreateInvitation;
      const beforeAccept = yield* OrganizationHooks.BeforeAcceptInvitation;
      const afterAccept = yield* OrganizationHooks.AfterAcceptInvitation;
      const beforeReject = yield* OrganizationHooks.BeforeRejectInvitation;
      const afterReject = yield* OrganizationHooks.AfterRejectInvitation;
      const beforeCancel = yield* OrganizationHooks.BeforeCancelInvitation;
      const afterCancel = yield* OrganizationHooks.AfterCancelInvitation;
      const beforeCreateRole = yield* OrganizationHooks.BeforeCreateRole;
      const afterCreateRole = yield* OrganizationHooks.AfterCreateRole;
      const beforeUpdateRoleHook = yield* OrganizationHooks.BeforeUpdateRole;
      const afterUpdateRoleHook = yield* OrganizationHooks.AfterUpdateRole;
      const beforeDeleteRole = yield* OrganizationHooks.BeforeDeleteRole;
      const afterDeleteRole = yield* OrganizationHooks.AfterDeleteRole;
      const beforeCreateTeam = yield* OrganizationHooks.BeforeCreateTeam;
      const afterCreateTeam = yield* OrganizationHooks.AfterCreateTeam;
      const beforeUpdateTeam = yield* OrganizationHooks.BeforeUpdateTeam;
      const afterUpdateTeam = yield* OrganizationHooks.AfterUpdateTeam;
      const beforeMoveTeam = yield* OrganizationHooks.BeforeMoveTeam;
      const afterMoveTeam = yield* OrganizationHooks.AfterMoveTeam;
      const beforeDeleteTeam = yield* OrganizationHooks.BeforeDeleteTeam;
      const afterDeleteTeam = yield* OrganizationHooks.AfterDeleteTeam;
      const beforeAddTeamMember = yield* OrganizationHooks.BeforeAddTeamMember;
      const afterAddTeamMember = yield* OrganizationHooks.AfterAddTeamMember;
      const beforeUpdateTeamMemberRole = yield* OrganizationHooks.BeforeUpdateTeamMemberRole;
      const afterUpdateTeamMemberRole = yield* OrganizationHooks.AfterUpdateTeamMemberRole;
      const beforeRemoveTeamMember = yield* OrganizationHooks.BeforeRemoveTeamMember;
      const afterRemoveTeamMember = yield* OrganizationHooks.AfterRemoveTeamMember;

      /**
       * JH-001/PERS-001: BEH-EA-090 requires a veto abort to reach the
       * caller as a typed error naming its `code`, not the bare defect
       * `Effect.orDie` previously turned every `before*.run(...)` failure
       * into. Translates `HookPoint.HookAbort` into the shared, wire-shaped
       * `HookPoint.HookAborted` right where each veto point is run, naming
       * that point's own id — every other call site's `.pipe(Effect.orDie)`
       * in this file (a DB-layer invariant violation, never a policy
       * denial) is unaffected.
       */
      const veto = <A>(
        point: string,
        effect: Effect.Effect<A, HookPoint.HookAbort>,
      ): Effect.Effect<A, HookPoint.HookAborted> =>
        effect.pipe(
          Effect.catchTag(
            "HookAbort",
            (abort) =>
              new HookPoint.HookAborted({ point, code: abort.code, message: abort.message }),
          ),
        );

      /** Static statements plus, when dynamic access control is enabled, every custom role this organization has defined. */
      const statementsByRole = (organizationId: string) =>
        orgConfig.dynamicAccessControl.enabled
          ? orgRoles.listByOrganization(organizationId).pipe(
              Effect.map((rows) => {
                const dynamic: Record<string, PermissionEngine.Statements> = {};
                for (const row of rows) dynamic[row.role] = row.permission;
                return PermissionEngine.statementsByRoleFrom(
                  orgConfig.permissionStatements,
                  dynamic,
                );
              }),
            )
          : Effect.succeed(PermissionEngine.statementsByRoleFrom(orgConfig.permissionStatements));

      const effectivePermissionsOf = (
        organizationId: string,
        membership: MembershipRecords.MembershipRecord,
      ) =>
        statementsByRole(organizationId).pipe(
          Effect.map((byRole) => PermissionEngine.effectivePermissions(membership.role, byRole)),
        );

      /**
       * MTI-009 (BEH-EA-147): a caller who is not a member of the organization
       * gets `OrganizationNotFound` — byte-identical to the answer for an id that
       * does not exist, so a denial never reveals that a tenant exists.
       * `OrganizationPermissionDenied` (403) is reserved for a *member* who lacks
       * the requested statement.
       */
      /**
       * OHS-004: the team-role statements a `TeamMembershipRecord` may hold —
       * `member` (nothing) plus whatever `OrganizationConfig.teamStatements` defines.
       */
      const teamRoleStatements: ReadonlyMap<string, PermissionEngine.Statements> = new Map([
        ["member", {}],
        ...Object.entries(orgConfig.teamStatements),
      ]);

      /**
       * OHS-004: what the caller's *team* roles confer on `teamId`: the statements of
       * every role they hold on that team or any ancestor of it (authority flows down
       * the subtree, never up or sideways).
       */
      const teamRoleAuthority = (callerId: Users.UserId, organizationId: string, teamId: string) =>
        Effect.gen(function* () {
          const ancestors = yield* teams.getAncestors(organizationId, teamId);
          let authority: PermissionEngine.Statements = {};
          for (const id of [teamId, ...ancestors.map((team) => team.id)]) {
            const held = yield* teams.findTeamMembership(id, callerId);
            if (Option.isSome(held)) {
              authority = PermissionEngine.mergeStatements(
                authority,
                PermissionEngine.effectivePermissions(held.value.role, teamRoleStatements),
              );
            }
          }
          return authority;
        });

      /**
       * `teamId`, when given, widens the check for the `team` resource with the
       * caller's team-scoped roles (`teamRoleAuthority`) — org-level statements are
       * always the default, a team role only ever adds.
       */
      const requirePermission = (
        callerId: Users.UserId,
        organizationId: string,
        resource: string,
        action: string,
        teamId?: string,
      ) =>
        Effect.gen(function* () {
          // PERS-005: every PermissionEngine denial leaves a durable who/what/why.
          const denied = (reason: "notMember" | "missingStatement") =>
            events.publish({
              _tag: "auth.organization.permissionDenied",
              organizationId,
              userId: callerId,
              resource,
              action,
              reason,
            });
          const membership = yield* members.findByUserAndOrg(callerId, organizationId);
          if (Option.isNone(membership)) {
            yield* denied("notMember");
            return yield* Effect.fail(new OrganizationApi.OrganizationNotFound());
          }
          const orgEffective = yield* effectivePermissionsOf(organizationId, membership.value);
          const effective =
            teamId !== undefined && resource === "team"
              ? PermissionEngine.mergeStatements(
                  orgEffective,
                  yield* teamRoleAuthority(callerId, organizationId, teamId),
                )
              : orgEffective;
          if (!PermissionEngine.hasPermission(effective, resource, action)) {
            yield* denied("missingStatement");
            return yield* Effect.fail(new OrganizationApi.OrganizationPermissionDenied());
          }
          return membership.value;
        });

      /**
       * RRM-001/RRM-002: every role-assignment path stores only role names this
       * organization recognizes (built-in, static custom, or a live dynamic role).
       */
      const requireKnownRoles = (
        byRole: ReadonlyMap<string, PermissionEngine.Statements>,
        roleNames: ReadonlyArray<string>,
      ) =>
        roleNames.some((name) => !byRole.has(name))
          ? Effect.fail(new OrganizationApi.UnknownOrgRole())
          : Effect.void;

      /**
       * RRM-001/RRM-002: the same self-escalation guard `createRole`/`updateRole`
       * already apply — a granter can only confer statements it itself holds
       * (`PermissionEngine.canGrant`), over role names that actually exist.
       */
      const requireGrantable = (
        organizationId: string,
        granter: MembershipRecords.MembershipRecord,
        roleNames: ReadonlyArray<string>,
      ) =>
        Effect.gen(function* () {
          const byRole = yield* statementsByRole(organizationId);
          yield* requireKnownRoles(byRole, roleNames);
          const held = PermissionEngine.effectivePermissions(granter.role, byRole);
          const requested = PermissionEngine.effectivePermissions(roleNames, byRole);
          if (!PermissionEngine.canGrant(requested, held)) {
            return yield* Effect.fail(new OrganizationApi.RolePermissionEscalation());
          }
        });

      /**
       * OHS-004: the same guards as `requireGrantable`/`requireOutranks`, for team roles —
       * the names must be defined, and what they confer (and, when re-roling, what the
       * target already holds) must be within the granter's authority over this team.
       */
      const requireGrantableTeamRole = (
        granterId: Users.UserId,
        organizationId: string,
        teamId: string,
        roleNames: ReadonlyArray<string>,
        current?: ReadonlyArray<string>,
      ) =>
        Effect.gen(function* () {
          if (roleNames.some((name) => !teamRoleStatements.has(name))) {
            return yield* Effect.fail(new OrganizationApi.UnknownTeamRole());
          }
          const granter = yield* requireMembership(granterId, organizationId);
          const held = PermissionEngine.mergeStatements(
            yield* effectivePermissionsOf(organizationId, granter),
            yield* teamRoleAuthority(granterId, organizationId, teamId),
          );
          const requested = PermissionEngine.effectivePermissions(roleNames, teamRoleStatements);
          const outranked =
            current === undefined
              ? {}
              : PermissionEngine.effectivePermissions(current, teamRoleStatements);
          if (
            !PermissionEngine.canGrant(requested, held) ||
            !PermissionEngine.canGrant(outranked, held)
          ) {
            return yield* Effect.fail(new OrganizationApi.RolePermissionEscalation());
          }
        });

      /** RRM-001: a lower tier cannot alter (demote/reshape) a member who out-privileges it. */
      const requireOutranks = (
        organizationId: string,
        granter: MembershipRecords.MembershipRecord,
        target: MembershipRecords.MembershipRecord,
      ) =>
        Effect.gen(function* () {
          const byRole = yield* statementsByRole(organizationId);
          const held = PermissionEngine.effectivePermissions(granter.role, byRole);
          const targetHeld = PermissionEngine.effectivePermissions(target.role, byRole);
          if (!PermissionEngine.canGrant(targetHeld, held)) {
            return yield* Effect.fail(new OrganizationApi.RolePermissionEscalation());
          }
        });

      /** Fails `OrganizationNotFound` (MTI-009) if the caller isn't a member — no statement check, for read endpoints any member may use. */
      const requireMembership = (callerId: Users.UserId, organizationId: string) =>
        members.findByUserAndOrg(callerId, organizationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationApi.OrganizationNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        );

      const requireOrganization = (organizationId: string) =>
        orgs.findById(organizationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationApi.OrganizationNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        );

      const create: OrganizationShape["create"] = Effect.fnUntraced(function* ({
        caller,
        name,
        slug,
        logo,
        metadata,
      }) {
        const callerId = Users.UserId(caller.ref.id);
        const allowed = yield* orgConfig.allowUserToCreateOrganization(callerId);
        if (!allowed)
          return yield* Effect.fail(new OrganizationApi.OrganizationCreationNotAllowed());

        const ownedOrgs = yield* members.listByUser(callerId);
        const ownedCount = ownedOrgs.filter((m) => m.role.includes(orgConfig.creatorRole)).length;
        if (ownedCount >= orgConfig.organizationLimit) {
          return yield* Effect.fail(new OrganizationApi.OrganizationLimitReached());
        }

        const vetoed = yield* veto(
          "organization.create.before",
          beforeCreate.run({ callerId, name, slug }),
        );

        const record = yield* orgs
          .create({ name: vetoed.name, slug: vetoed.slug, logo, metadata })
          .pipe(
            Effect.catchTag("OrganizationRecordSlugTaken", () =>
              Effect.fail(new OrganizationApi.OrganizationSlugTaken()),
            ),
          );
        // A brand-new organization has no memberships, so this cannot collide.
        const membership = yield* members
          .create({
            userId: callerId,
            organizationId: record.id,
            role: [orgConfig.creatorRole],
          })
          .pipe(Effect.catchTag("MembershipRecordAlreadyExists", Effect.die));
        yield* events.publish({
          _tag: "auth.organization.created",
          organizationId: record.id,
          creatorUserId: callerId,
        });
        yield* events.publish({
          _tag: "auth.organization.memberAdded",
          organizationId: record.id,
          userId: callerId,
          role: membership.role,
        });

        yield* afterCreate.run({
          callerId,
          name: vetoed.name,
          slug: vetoed.slug,
          organizationId: record.id,
        });

        return record;
      });

      const checkSlug: OrganizationShape["checkSlug"] = (slug) =>
        orgs.findBySlug(slug).pipe(Effect.map(Option.isNone));

      const list: OrganizationShape["list"] = (caller) =>
        members
          .listByUser(Users.UserId(caller.ref.id))
          .pipe(Effect.flatMap((rows) => orgs.listByIds(rows.map((r) => r.organizationId))));

      const get: OrganizationShape["get"] = Effect.fnUntraced(function* (caller, organizationId) {
        const record = yield* requireOrganization(organizationId);
        yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
        return record;
      });

      const getFull: OrganizationShape["getFull"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          const record = yield* requireOrganization(organizationId);
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          const memberRows = yield* members.listByOrganization(organizationId, {
            limit: input?.membersLimit,
            offset: input?.membersOffset,
          });
          const invitationRows = yield* invitations
            .listByOrganization(organizationId)
            .pipe(Effect.map((rows) => rows.filter((row) => row.status === "pending")));
          return { organization: record, members: memberRows, invitations: invitationRows };
        },
      );

      const update: OrganizationShape["update"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          yield* requireOrganization(organizationId);
          yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "organization",
            "update",
          );
          const vetoed = yield* veto(
            "organization.update.before",
            beforeUpdate.run({ organizationId, name: input.name, slug: input.slug }),
          );
          const record = yield* orgs
            .update(organizationId, { ...input, name: vetoed.name, slug: vetoed.slug })
            .pipe(
              Effect.catchTag("OrganizationRecordNotFound", () =>
                Effect.die(new Error("awthaq: organization vanished between check and write")),
              ),
              Effect.catchTag("OrganizationRecordSlugTaken", () =>
                Effect.fail(new OrganizationApi.OrganizationSlugTaken()),
              ),
            );
          yield* events.publish({ _tag: "auth.organization.updated", organizationId });
          yield* afterUpdate.run({ organizationId, name: vetoed.name, slug: vetoed.slug });
          return record;
        },
      );

      const delete_: OrganizationShape["delete"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          yield* requireOrganization(organizationId);
          if (orgConfig.disableOrganizationDeletion) {
            return yield* Effect.fail(new OrganizationApi.OrganizationDeletionDisabled());
          }
          yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "organization",
            "delete",
          );
          yield* veto("organization.delete.before", beforeDelete.run({ organizationId }));
          // OHS-002: the five-table cascade is one transaction — a failure at any
          // step leaves every organization_* row untouched. Hooks and events stay
          // outside it: they only run once the delete has committed.
          yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                yield* members.removeAllForOrganization(organizationId);
                yield* invitations.removeAllForOrganization(organizationId);
                yield* teams.removeAllTeamsForOrganization(organizationId);
                yield* orgRoles.removeAllForOrganization(organizationId);
                // CWM-003: no session may keep pointing at the deleted organization.
                yield* activeContext.clearOrganization(organizationId);
                yield* orgs
                  .delete(organizationId)
                  .pipe(
                    Effect.catchTag("OrganizationRecordNotFound", () =>
                      Effect.die(
                        new Error("awthaq: organization vanished between check and write"),
                      ),
                    ),
                  );
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
          yield* events.publish({ _tag: "auth.organization.deleted", organizationId });
          yield* afterDelete.run({ organizationId });
        },
      );

      const listMembers: OrganizationShape["listMembers"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          yield* requireOrganization(organizationId);
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          return yield* members.listByOrganization(organizationId, input);
        },
      );

      /** True iff removing/changing a membership's role away from `owner` would leave zero owners. */
      const wouldViolateOwnerInvariant = (
        organizationId: string,
        targetHeldOwner: boolean,
        nextHeldOwner: boolean,
      ) =>
        targetHeldOwner && !nextHeldOwner
          ? members.countOwners(organizationId).pipe(Effect.map((count) => count <= 1))
          : Effect.succeed(false);

      /**
       * CWM-003/N9: removing a membership (`removeMember` and `leave` alike) also
       * drops everything that hangs off it — the user's team memberships in this
       * organization and any session's active organization/team pointing at it —
       * in one transaction, so a removed member can no longer answer `team-member`
       * in qadi or keep the organization "active". Returns the teams the user was
       * on so the caller can announce each departure once the transaction commits.
       */
      const dropMembership = (organizationId: string, userId: Users.UserId) =>
        sqlTransaction
          .withTransaction(
            Effect.gen(function* () {
              yield* members
                .remove(userId, organizationId)
                .pipe(
                  Effect.catchTag("MembershipRecordNotFound", () =>
                    Effect.die(new Error("awthaq: membership vanished between check and write")),
                  ),
                );
              yield* activeContext.clearOrganizationForUser(userId, organizationId);
              return yield* teams.removeUserFromOrganizationTeams(organizationId, userId);
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));

      const announceTeamDepartures = (
        organizationId: string,
        userId: Users.UserId,
        teamIds: ReadonlyArray<string>,
      ) =>
        Effect.forEach(
          teamIds,
          (teamId) =>
            events
              .publish({
                _tag: "auth.organization.teamMemberRemoved",
                organizationId,
                teamId,
                userId,
              })
              .pipe(Effect.andThen(afterRemoveTeamMember.run({ organizationId, teamId, userId }))),
          { discard: true },
        );

      const removeMember: OrganizationShape["removeMember"] = Effect.fnUntraced(
        function* (caller, organizationId, targetUserId) {
          yield* requireOrganization(organizationId);
          // MTI-009: a non-member learns nothing about who else is in the
          // organization — the target lookup below would otherwise answer
          // `MembershipNotFound` before any permission check.
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          const target = yield* members.findByUserAndOrg(targetUserId, organizationId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new OrganizationApi.MembershipNotFound()),
                onSome: Effect.succeed,
              }),
            ),
          );
          const violates = yield* wouldViolateOwnerInvariant(
            organizationId,
            target.role.includes("owner"),
            false,
          );
          if (violates) return yield* Effect.fail(new OrganizationApi.OwnerInvariantViolation());

          yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "member", "delete");
          yield* veto(
            "organization.member.remove.before",
            beforeRemove.run({ organizationId, userId: targetUserId }),
          );
          const leftTeams = yield* dropMembership(organizationId, targetUserId);
          yield* events.publish({
            _tag: "auth.organization.memberRemoved",
            organizationId,
            userId: targetUserId,
          });
          yield* announceTeamDepartures(organizationId, targetUserId, leftTeams);
          yield* afterRemove.run({ organizationId, userId: targetUserId });
        },
      );

      const updateMemberRole: OrganizationShape["updateMemberRole"] = Effect.fnUntraced(
        function* (caller, organizationId, targetUserId, role) {
          yield* requireOrganization(organizationId);
          // MTI-009: see `removeMember`.
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          const target = yield* members.findByUserAndOrg(targetUserId, organizationId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new OrganizationApi.MembershipNotFound()),
                onSome: Effect.succeed,
              }),
            ),
          );
          const violates = yield* wouldViolateOwnerInvariant(
            organizationId,
            target.role.includes("owner"),
            role.includes("owner"),
          );
          if (violates) return yield* Effect.fail(new OrganizationApi.OwnerInvariantViolation());

          const granter = yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "member",
            "update",
          );
          const vetoed = yield* veto(
            "organization.member.updateRole.before",
            beforeUpdateRole.run({ organizationId, userId: targetUserId, role }),
          );
          // RRM-001: after the veto hook (a tap may rewrite the role), the
          // caller must hold every statement it is conferring, and must not
          // out-privilege-lose against the member it is changing.
          yield* requireOutranks(organizationId, granter, target);
          yield* requireGrantable(organizationId, granter, vetoed.role);
          const updated = yield* members
            .updateRole(targetUserId, organizationId, vetoed.role)
            .pipe(
              Effect.catchTag("MembershipRecordNotFound", () =>
                Effect.die(new Error("awthaq: membership vanished between check and write")),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.memberRoleUpdated",
            organizationId,
            userId: targetUserId,
            role: vetoed.role,
          });
          yield* afterUpdateRole.run({ organizationId, userId: targetUserId, role: vetoed.role });
          return updated;
        },
      );

      const leave: OrganizationShape["leave"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          yield* requireOrganization(organizationId);
          const callerId = Users.UserId(caller.ref.id);
          const own = yield* members.findByUserAndOrg(callerId, organizationId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new OrganizationApi.MembershipNotFound()),
                onSome: Effect.succeed,
              }),
            ),
          );
          const violates = yield* wouldViolateOwnerInvariant(
            organizationId,
            own.role.includes("owner"),
            false,
          );
          if (violates) return yield* Effect.fail(new OrganizationApi.OwnerInvariantViolation());

          // PCS-002: `leave` removes a membership like `removeMember` does, so it
          // runs the same remove-member hooks — `DecisionCacheInvalidationLive`
          // (and any other observer) must see a member leaving.
          yield* veto(
            "organization.member.remove.before",
            beforeRemove.run({ organizationId, userId: callerId }),
          );
          const leftTeams = yield* dropMembership(organizationId, callerId);
          yield* events.publish({
            _tag: "auth.organization.memberRemoved",
            organizationId,
            userId: callerId,
          });
          yield* announceTeamDepartures(organizationId, callerId, leftTeams);
          yield* afterRemove.run({ organizationId, userId: callerId });
        },
      );

      const addMember: OrganizationShape["addMember"] = Effect.fnUntraced(function* ({
        organizationId,
        userId,
        role,
      }) {
        yield* requireOrganization(organizationId);
        const count = yield* members.countByOrganization(organizationId);
        if (count >= orgConfig.membershipLimit) {
          return yield* Effect.fail(new OrganizationApi.MembershipLimitReached());
        }
        const vetoed = yield* veto(
          "organization.member.add.before",
          beforeAdd.run({ organizationId, userId, role }),
        );
        // RRM-001: a trusted, caller-less server-side primitive (SCIM/import) —
        // it bypasses the grant guard by design, but still only stores role
        // names the organization recognizes.
        yield* requireKnownRoles(yield* statementsByRole(organizationId), vetoed.role);
        // MTI-003: never overwrite or duplicate an existing membership — a role
        // change goes through `updateMemberRole` (and its canGrant guard).
        const existing = yield* members.findByUserAndOrg(userId, organizationId);
        if (Option.isSome(existing)) return yield* Effect.fail(new OrganizationApi.AlreadyMember());
        const membership = yield* members
          .create({ userId, organizationId, role: vetoed.role })
          .pipe(
            Effect.catchTag("MembershipRecordAlreadyExists", () =>
              Effect.fail(new OrganizationApi.AlreadyMember()),
            ),
          );
        yield* events.publish({
          _tag: "auth.organization.memberAdded",
          organizationId,
          userId,
          role: vetoed.role,
        });
        yield* afterAdd.run({ organizationId, userId, role: vetoed.role });
        return membership;
      });

      const activeOrganizationOf = (caller: Api.UserPrincipal) =>
        activeContext.findBySessionId(caller.sessionId).pipe(
          Effect.map(Option.flatMap((row) => row.activeOrganizationId)),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationApi.NoActiveOrganization()),
              onSome: Effect.succeed,
            }),
          ),
        );

      const getActiveMember: OrganizationShape["getActiveMember"] = Effect.fnUntraced(
        function* (caller) {
          const organizationId = yield* activeOrganizationOf(caller);
          const membership = yield* members.findByUserAndOrg(
            Users.UserId(caller.ref.id),
            organizationId,
          );
          if (Option.isNone(membership))
            return yield* Effect.fail(new OrganizationApi.NoActiveOrganization());
          return membership.value;
        },
      );

      const getActiveMemberRole: OrganizationShape["getActiveMemberRole"] = (caller) =>
        getActiveMember(caller).pipe(Effect.map((membership) => membership.role));

      const setActive: OrganizationShape["setActive"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          const callerId = Users.UserId(caller.ref.id);
          if (organizationId === null) {
            return yield* activeContext.unsetOrganization(caller.sessionId, callerId);
          }
          const membership = yield* members.findByUserAndOrg(callerId, organizationId);
          if (Option.isNone(membership))
            return yield* Effect.fail(new OrganizationApi.MembershipNotFound());
          // MTI-001: the membership record is the witness the setter requires.
          return yield* activeContext.setOrganization(caller.sessionId, membership.value);
        },
      );

      /**
       * CWM-003: the stored pointers are re-validated on read — a row whose
       * organization/team the user no longer belongs to (a membership removed
       * around this plugin, or a row that predates the `userId` column, which
       * the cascade could not find) reads as cleared, and is cleared for real.
       */
      const revalidateActive = Effect.fnUntraced(function* (
        caller: Api.UserPrincipal,
        row: ActiveContextRecords.ActiveContextRecord,
      ) {
        const callerId = Users.UserId(caller.ref.id);
        let stale = false;
        if (Option.isSome(row.activeOrganizationId)) {
          const membership = yield* members.findByUserAndOrg(
            callerId,
            row.activeOrganizationId.value,
          );
          if (Option.isNone(membership)) {
            yield* activeContext.unsetOrganization(caller.sessionId, callerId);
            yield* activeContext.unsetTeam(caller.sessionId, callerId);
            stale = true;
          }
        }
        if (!stale && Option.isSome(row.activeTeamId)) {
          const onTeam = yield* teams.findTeamMembership(row.activeTeamId.value, callerId);
          if (Option.isNone(onTeam)) {
            yield* activeContext.unsetTeam(caller.sessionId, callerId);
            stale = true;
          }
        }
        if (!stale) return row;
        const refreshed = yield* activeContext.findBySessionId(caller.sessionId);
        return Option.getOrElse(refreshed, () => row);
      });

      const getActive: OrganizationShape["getActive"] = Effect.fnUntraced(function* (caller) {
        const existing = yield* activeContext.findBySessionId(caller.sessionId);
        if (Option.isSome(existing)) return yield* revalidateActive(caller, existing.value);
        const now = yield* DateTime.now;
        const empty: ActiveContextRecords.ActiveContextRecord = {
          sessionId: caller.sessionId,
          userId: Option.some(caller.ref.id),
          activeOrganizationId: Option.none(),
          activeTeamId: Option.none(),
          updatedAt: now,
        };
        return empty;
      });

      // ---- invitations --------------------------------------------------------

      const invite: OrganizationShape["invite"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          const organizationRecord = yield* requireOrganization(organizationId);
          const callerId = Users.UserId(caller.ref.id);
          const inviter = yield* requirePermission(
            callerId,
            organizationId,
            "invitation",
            "create",
          );

          const pendingCount = yield* invitations.countPendingByInviter(callerId);
          if (pendingCount >= orgConfig.invitationLimit) {
            return yield* Effect.fail(new OrganizationApi.InvitationLimitReached());
          }

          if (input.teamId !== undefined) {
            if (!orgConfig.teams.enabled) {
              return yield* Effect.fail(new OrganizationApi.TeamsDisabled());
            }
            yield* requireTeam(organizationId, input.teamId);
          }

          const vetoed = yield* veto(
            "organization.invitation.create.before",
            beforeCreateInvitation.run({ organizationId, email: input.email, role: input.role }),
          );
          // RRM-002: an invitation can only confer statements the inviter holds.
          yield* requireGrantable(organizationId, inviter, vetoed.role);

          const alreadyMember = yield* users.findByEmail(vetoed.email).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(Option.none<MembershipRecords.MembershipRecord>()),
                onSome: (user) => members.findByUserAndOrg(user.id, organizationId),
              }),
            ),
          );
          const existing = yield* invitations.findPendingByEmailAndOrg(
            vetoed.email,
            organizationId,
          );

          // OHS-006: an existing member is never invited again (an invitation
          // could otherwise overwrite or duplicate the membership on accept);
          // any pending invitation for them is stale, so cancel it first.
          if (Option.isSome(alreadyMember)) {
            if (Option.isSome(existing)) {
              yield* invitations.updateStatus(existing.value.id, "canceled").pipe(Effect.orDie);
            }
            return yield* Effect.fail(new OrganizationApi.AlreadyMember());
          }

          const expiresAt = yield* DateTime.now.pipe(
            Effect.map((now) => DateTime.addDuration(now, orgConfig.invitationExpiresIn)),
          );

          // MTI-010: the mailed capability is a fresh random token (only its hash
          // is stored), never the invitation's own id.
          // EEM-002: the inviter is authenticated, so a delivery failure is
          // surfaced (the invitation stays pending; re-inviting with
          // `resend: true` retries) rather than swallowed.
          const sendInvite = (record: InvitationRecords.InvitationRecord, token: string) =>
            mailer
              .send({
                to: record.email,
                template: "organization-invite",
                data: {
                  token,
                  invitationId: record.id,
                  organizationId,
                  organizationName: organizationRecord.name,
                  role: record.role,
                },
              })
              .pipe(
                Effect.catchTag(
                  "MailDeliveryFailed",
                  () => new OrganizationApi.InvitationDeliveryFailed({ invitationId: record.id }),
                ),
              );

          if (Option.isNone(alreadyMember) && Option.isSome(existing)) {
            if (orgConfig.cancelPendingInvitationsOnReInvite) {
              yield* invitations.updateStatus(existing.value.id, "canceled").pipe(Effect.orDie);
            } else if (input.resend) {
              // A resend mints a new token (only the hash is kept, so the old
              // mail cannot be re-sent) and retires the previous one.
              const fresh = yield* mintInvitationToken;
              const rotated = yield* invitations
                .setTokenHash(existing.value.id, fresh.tokenHash)
                .pipe(Effect.orDie);
              yield* sendInvite(rotated, fresh.token);
              yield* events.publish({
                _tag: "auth.organization.invitationCreated",
                invitationId: rotated.id,
                organizationId,
              });
              return rotated;
            } else {
              return existing.value;
            }
          }

          const minted = yield* mintInvitationToken;
          const record = yield* invitations.create({
            email: vetoed.email,
            inviterId: callerId,
            organizationId,
            teamId: input.teamId,
            role: vetoed.role,
            expiresAt,
            tokenHash: minted.tokenHash,
          });
          // The record exists from here on, so its creation is published
          // before the mail attempt: a delivery failure leaves a pending
          // invitation, not a phantom one.
          yield* events.publish({
            _tag: "auth.organization.invitationCreated",
            invitationId: record.id,
            organizationId,
          });
          yield* afterCreateInvitation.run({
            organizationId,
            email: record.email,
            role: vetoed.role,
            invitationId: record.id,
          });
          yield* sendInvite(record, minted.token);
          return record;
        },
      );

      /** Hex SHA-256 of an invitation token — the only form of it ever stored. */
      const hashInvitationToken = (token: string) =>
        crypto
          .digest("SHA-256", new TextEncoder().encode(token))
          .pipe(Effect.map(hexOf), Effect.orDie);

      const mintInvitationToken = Effect.gen(function* () {
        const token = hexOf(yield* crypto.randomBytes(32).pipe(Effect.orDie));
        return { token, tokenHash: yield* hashInvitationToken(token) };
      });

      /**
       * MTI-010: proves the caller holds the emailed token for `invitationId`
       * (constant-time hash comparison). An unknown id, a wrong token and a
       * pre-column invitation with no stored hash all answer the same
       * `InvitationNotFound`, so knowing an id reveals nothing.
       */
      const requireInvitationToken = (invitationId: string, token: string) =>
        Effect.gen(function* () {
          const found = yield* invitations.findById(invitationId);
          const presented = yield* hashInvitationToken(token);
          const stored = Option.flatMap(found, (record) => record.tokenHash);
          const matches = constantTimeEqual(
            presented,
            Option.getOrElse(stored, () => NO_INVITATION_TOKEN_HASH),
          );
          if (Option.isNone(found) || Option.isNone(stored) || !matches) {
            return yield* Effect.fail(new OrganizationApi.InvitationNotFound());
          }
          return found.value;
        });

      const requirePendingInvitation = (invitationId: string, token: string) =>
        requireInvitationToken(invitationId, token).pipe(
          Effect.flatMap((record) =>
            record.status === "pending"
              ? Effect.succeed(record)
              : Effect.fail(new OrganizationApi.InvitationNotPending()),
          ),
        );

      const acceptInvitation: OrganizationShape["acceptInvitation"] = Effect.fnUntraced(
        function* (caller, invitationId, token) {
          yield* veto("organization.invitation.accept.before", beforeAccept.run({ invitationId }));

          const record = yield* requirePendingInvitation(invitationId, token);

          const now = yield* DateTime.now;
          if (DateTime.isGreaterThan(now, record.expiresAt)) {
            yield* invitations.updateStatus(invitationId, "expired").pipe(Effect.orDie);
            return yield* Effect.fail(new OrganizationApi.InvitationExpired());
          }

          const callerId = Users.UserId(caller.ref.id);
          const user = yield* users.findById(callerId).pipe(Effect.orDie);
          if (user.email.toLowerCase() !== record.email) {
            return yield* Effect.fail(new OrganizationApi.InvitationEmailMismatch());
          }
          if (orgConfig.requireEmailVerificationOnInvitation && !user.emailVerified) {
            return yield* Effect.fail(new OrganizationApi.EmailVerificationRequired());
          }

          // OHS-006: accepting can never overwrite or duplicate a membership —
          // the invitation is stale (the user was admitted another way), so it
          // is canceled and the existing roles stay untouched.
          const alreadyMember = yield* members.findByUserAndOrg(callerId, record.organizationId);
          if (Option.isSome(alreadyMember)) {
            yield* invitations.updateStatus(invitationId, "canceled").pipe(Effect.orDie);
            return yield* Effect.fail(new OrganizationApi.AlreadyMember());
          }

          const count = yield* members.countByOrganization(record.organizationId);
          if (count >= orgConfig.membershipLimit) {
            return yield* Effect.fail(new OrganizationApi.MembershipLimitReached());
          }

          if (Option.isSome(record.teamId)) {
            const team = yield* teams.findTeamById(record.organizationId, record.teamId.value).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.die(new Error("awthaq: invitation's team vanished before acceptance")),
                  onSome: Effect.succeed,
                }),
              ),
            );
            if (team.memberCount >= orgConfig.teams.maximumMembersPerTeam) {
              return yield* Effect.fail(new OrganizationApi.TeamMemberLimitReached());
            }
          }

          const membership = yield* members
            .create({
              userId: callerId,
              organizationId: record.organizationId,
              role: record.role,
            })
            .pipe(
              Effect.catchTag("MembershipRecordAlreadyExists", () =>
                Effect.fail(new OrganizationApi.AlreadyMember()),
              ),
            );
          yield* invitations.updateStatus(invitationId, "accepted").pipe(Effect.orDie);
          yield* events.publish({
            _tag: "auth.organization.invitationAccepted",
            invitationId,
            organizationId: record.organizationId,
            userId: callerId,
          });
          yield* events.publish({
            _tag: "auth.organization.memberAdded",
            organizationId: record.organizationId,
            userId: callerId,
            role: membership.role,
          });
          if (Option.isSome(record.teamId)) {
            const teamId = record.teamId.value;
            // OHS-003: the team half of accepting stays idempotent — a user who
            // is already on the team is not double-counted.
            const added = yield* teams.addTeamMember({ teamId, userId: callerId }).pipe(
              Effect.as(true),
              Effect.catchTag("TeamMembershipRecordAlreadyExists", () => Effect.succeed(false)),
            );
            if (added) {
              yield* events.publish({
                _tag: "auth.organization.teamMemberAdded",
                organizationId: record.organizationId,
                teamId,
                userId: callerId,
              });
            }
          }
          yield* afterAccept.run({
            invitationId,
            organizationId: record.organizationId,
            userId: callerId,
          });
          return membership;
        },
      );

      const rejectInvitation: OrganizationShape["rejectInvitation"] = Effect.fnUntraced(
        function* (caller, invitationId, token) {
          yield* veto("organization.invitation.reject.before", beforeReject.run({ invitationId }));

          const record = yield* requirePendingInvitation(invitationId, token);
          const callerId = Users.UserId(caller.ref.id);
          const user = yield* users.findById(callerId).pipe(Effect.orDie);
          if (user.email.toLowerCase() !== record.email) {
            return yield* Effect.fail(new OrganizationApi.InvitationEmailMismatch());
          }
          yield* invitations.updateStatus(invitationId, "rejected").pipe(Effect.orDie);
          yield* events.publish({
            _tag: "auth.organization.invitationRejected",
            invitationId,
            organizationId: record.organizationId,
          });
          yield* afterReject.run({ invitationId });
        },
      );

      const cancelInvitation: OrganizationShape["cancelInvitation"] = Effect.fnUntraced(
        function* (caller, invitationId) {
          yield* veto("organization.invitation.cancel.before", beforeCancel.run({ invitationId }));

          // MTI-009: a non-member must not be able to tell an existing invitation
          // (or its status) from an unknown one, so membership is checked before
          // the pending check and answers the unknown-invitation error.
          const callerId = Users.UserId(caller.ref.id);
          const found = yield* invitations.findById(invitationId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new OrganizationApi.InvitationNotFound()),
                onSome: Effect.succeed,
              }),
            ),
          );
          const callerMembership = yield* members.findByUserAndOrg(callerId, found.organizationId);
          if (Option.isNone(callerMembership)) {
            return yield* Effect.fail(new OrganizationApi.InvitationNotFound());
          }
          const record = found;
          if (record.status !== "pending") {
            return yield* Effect.fail(new OrganizationApi.InvitationNotPending());
          }
          yield* requirePermission(callerId, record.organizationId, "invitation", "cancel").pipe(
            // Membership was just proven; a racing removal reads as "no such invitation".
            Effect.catchTag("OrganizationNotFound", () =>
              Effect.fail(new OrganizationApi.InvitationNotFound()),
            ),
          );
          yield* invitations.updateStatus(invitationId, "canceled").pipe(Effect.orDie);
          yield* events.publish({
            _tag: "auth.organization.invitationCanceled",
            invitationId,
            organizationId: record.organizationId,
          });
          yield* afterCancel.run({ invitationId });
        },
      );

      /** True iff `callerId` is the invitee (email match) or a member of the invitation's organization holding `invitation:create`. */
      const mayReadInvitation = (
        callerId: Users.UserId,
        record: InvitationRecords.InvitationRecord,
      ) =>
        Effect.gen(function* () {
          const membership = yield* members.findByUserAndOrg(callerId, record.organizationId);
          if (Option.isSome(membership)) {
            const effective = yield* effectivePermissionsOf(
              record.organizationId,
              membership.value,
            );
            if (PermissionEngine.hasPermission(effective, "invitation", "create")) return true;
          }
          const user = yield* users
            .findById(callerId)
            .pipe(Effect.catchTag("UserNotFound", () => Effect.succeed(undefined)));
          return user !== undefined && user.email.toLowerCase() === record.email;
        });

      const getInvitation: OrganizationShape["getInvitation"] = Effect.fnUntraced(
        function* (caller, invitationId) {
          const found = yield* invitations.findById(invitationId);
          if (Option.isNone(found))
            return yield* Effect.fail(new OrganizationApi.InvitationNotFound());
          const allowed = yield* mayReadInvitation(Users.UserId(caller.ref.id), found.value);
          if (!allowed) return yield* Effect.fail(new OrganizationApi.InvitationNotFound());
          return found.value;
        },
      );

      const getInvitationByToken: OrganizationShape["getInvitationByToken"] = Effect.fnUntraced(
        function* (caller, token) {
          const found = yield* invitations.findByTokenHash(yield* hashInvitationToken(token));
          if (Option.isNone(found))
            return yield* Effect.fail(new OrganizationApi.InvitationNotFound());
          const user = yield* users
            .findById(Users.UserId(caller.ref.id))
            .pipe(Effect.catchTag("UserNotFound", () => Effect.succeed(undefined)));
          if (user === undefined || user.email.toLowerCase() !== found.value.email) {
            return yield* Effect.fail(new OrganizationApi.InvitationNotFound());
          }
          return found.value;
        },
      );

      const listInvitationsForOrganization: OrganizationShape["listInvitationsForOrganization"] = (
        caller,
        organizationId,
      ) =>
        requireOrganization(organizationId).pipe(
          Effect.flatMap(() => requireMembership(Users.UserId(caller.ref.id), organizationId)),
          Effect.flatMap(() => invitations.listByOrganization(organizationId)),
        );

      const listInvitationsForUser: OrganizationShape["listInvitationsForUser"] = Effect.fnUntraced(
        function* (caller) {
          const callerId = Users.UserId(caller.ref.id);
          const user = yield* users.findById(callerId).pipe(Effect.orDie);
          return yield* invitations.listByEmail(user.email);
        },
      );

      // ---- dynamic access control -----------------------------------------------

      const requireDynamicAccessControlEnabled = orgConfig.dynamicAccessControl.enabled
        ? Effect.void
        : Effect.fail(new OrganizationApi.DynamicAccessControlDisabled());

      const createRole: OrganizationShape["createRole"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          yield* requireOrganization(organizationId);
          yield* requireDynamicAccessControlEnabled;
          const callerId = Users.UserId(caller.ref.id);
          const membership = yield* requirePermission(callerId, organizationId, "role", "create");

          // RZS-005/N8: a dynamic role never takes a built-in tier's name or an
          // application-defined static role's name.
          if (
            PermissionEngine.isBuiltInRole(input.role) ||
            Object.hasOwn(orgConfig.permissionStatements, input.role)
          ) {
            return yield* Effect.fail(new OrganizationApi.ReservedOrgRoleName());
          }

          const granterPermissions = yield* effectivePermissionsOf(organizationId, membership);
          if (!PermissionEngine.canGrant(input.permission, granterPermissions)) {
            return yield* Effect.fail(new OrganizationApi.RolePermissionEscalation());
          }

          const count = yield* orgRoles.countByOrganization(organizationId);
          if (count >= orgConfig.dynamicAccessControl.maximumRolesPerOrganization) {
            return yield* Effect.fail(new OrganizationApi.RoleLimitReached());
          }

          const vetoed = yield* veto(
            "organization.role.create.before",
            beforeCreateRole.run({ organizationId, role: input.role }),
          );

          const record = yield* orgRoles
            .create({ organizationId, role: vetoed.role, permission: input.permission })
            .pipe(
              Effect.catchTag("OrgRoleRecordNameTaken", () =>
                Effect.fail(new OrganizationApi.OrgRoleNameTaken()),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.roleCreated",
            organizationId,
            role: record.role,
          });
          yield* afterCreateRole.run({ organizationId, role: record.role, roleId: record.id });
          return record;
        },
      );

      const listRoles: OrganizationShape["listRoles"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          yield* requireOrganization(organizationId);
          yield* requireDynamicAccessControlEnabled;
          yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "role", "read");
          return yield* orgRoles.listByOrganization(organizationId);
        },
      );

      const requireOrgRole = (organizationId: string, roleId: string) =>
        orgRoles.findById(organizationId, roleId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationApi.OrgRoleNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        );

      const getRole: OrganizationShape["getRole"] = Effect.fnUntraced(
        function* (caller, organizationId, roleId) {
          yield* requireOrganization(organizationId);
          yield* requireDynamicAccessControlEnabled;
          yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "role", "read");
          return yield* requireOrgRole(organizationId, roleId);
        },
      );

      const updateRole: OrganizationShape["updateRole"] = Effect.fnUntraced(
        function* (caller, organizationId, roleId, permission) {
          yield* requireOrganization(organizationId);
          yield* requireDynamicAccessControlEnabled;
          const membership = yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "role",
            "update",
          );
          yield* requireOrgRole(organizationId, roleId);

          const granterPermissions = yield* effectivePermissionsOf(organizationId, membership);
          if (!PermissionEngine.canGrant(permission, granterPermissions)) {
            return yield* Effect.fail(new OrganizationApi.RolePermissionEscalation());
          }

          yield* veto(
            "organization.role.update.before",
            beforeUpdateRoleHook.run({ organizationId, roleId }),
          );

          const updated = yield* orgRoles
            .update(organizationId, roleId, permission)
            .pipe(
              Effect.catchTag("OrgRoleRecordNotFound", () =>
                Effect.die(new Error("awthaq: org role vanished between check and write")),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.roleUpdated",
            organizationId,
            role: updated.role,
          });
          yield* afterUpdateRoleHook.run({ organizationId, roleId });
          return updated;
        },
      );

      const deleteRole: OrganizationShape["deleteRole"] = Effect.fnUntraced(
        function* (caller, organizationId, roleId) {
          yield* requireOrganization(organizationId);
          yield* requireDynamicAccessControlEnabled;
          yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "role", "delete");
          const existing = yield* requireOrgRole(organizationId, roleId);
          yield* veto(
            "organization.role.delete.before",
            beforeDeleteRole.run({ organizationId, roleId }),
          );
          yield* orgRoles
            .remove(organizationId, roleId)
            .pipe(
              Effect.catchTag("OrgRoleRecordNotFound", () =>
                Effect.die(new Error("awthaq: org role vanished between check and write")),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.roleDeleted",
            organizationId,
            role: existing.role,
          });
          yield* afterDeleteRole.run({ organizationId, roleId });
        },
      );

      // ---- teams --------------------------------------------------------------

      const requireTeamsEnabled = orgConfig.teams.enabled
        ? Effect.void
        : Effect.fail(new OrganizationApi.TeamsDisabled());

      const requireTeam = (organizationId: string, teamId: string) =>
        teams.findTeamById(organizationId, teamId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationApi.TeamNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        );

      const createTeam: OrganizationShape["createTeam"] = Effect.fnUntraced(
        function* (caller, organizationId, name, parentId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsEnabled;
          // OHS-004: a nested team needs `team:create` on its parent (a team role held
          // on the parent or an ancestor suffices); a root team needs it org-level.
          yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "team",
            "create",
            parentId,
          );
          if (parentId !== undefined) yield* requireTeam(organizationId, parentId);
          const count = yield* teams.countTeamsByOrganization(organizationId);
          if (count >= orgConfig.teams.maximumTeams) {
            return yield* Effect.fail(new OrganizationApi.TeamLimitReached());
          }
          const vetoed = yield* veto(
            "organization.team.create.before",
            beforeCreateTeam.run({ organizationId, name, parentId }),
          );
          const record = yield* teams
            .createTeam({ organizationId, name: vetoed.name, parentId: vetoed.parentId })
            .pipe(
              Effect.catchTag("TeamRecordNotFound", () =>
                Effect.fail(new OrganizationApi.TeamNotFound()),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.teamCreated",
            organizationId,
            teamId: record.id,
          });
          yield* afterCreateTeam.run({
            organizationId,
            name: vetoed.name,
            parentId: vetoed.parentId,
            teamId: record.id,
          });
          return record;
        },
      );

      const moveTeam: OrganizationShape["moveTeam"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, parentId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsEnabled;
          // OHS-004: authority over the team *and* over its destination — a move can
          // hand a subtree to another team's leads, so the target's own authority is
          // required too; the root is org-level.
          const callerId = Users.UserId(caller.ref.id);
          yield* requirePermission(callerId, organizationId, "team", "update", teamId);
          yield* requirePermission(
            callerId,
            organizationId,
            "team",
            "update",
            Option.getOrUndefined(parentId),
          );
          yield* requireTeam(organizationId, teamId);
          if (Option.isSome(parentId)) yield* requireTeam(organizationId, parentId.value);
          const vetoed = yield* veto(
            "organization.team.move.before",
            beforeMoveTeam.run({ organizationId, teamId, parentId: Option.getOrNull(parentId) }),
          );
          const moved = yield* teams
            .moveTeam({ organizationId, id: teamId, parentId: Option.fromNullOr(vetoed.parentId) })
            .pipe(
              Effect.catchTags({
                TeamRecordNotFound: () => Effect.fail(new OrganizationApi.TeamNotFound()),
                TeamHierarchyCycle: () => Effect.fail(new OrganizationApi.TeamHierarchyCycle()),
              }),
            );
          yield* events.publish({
            _tag: "auth.organization.teamMoved",
            organizationId,
            teamId,
            parentId: vetoed.parentId,
          });
          yield* afterMoveTeam.run({ organizationId, teamId, parentId: vetoed.parentId });
          return moved;
        },
      );

      // OHS-001: relatives are read like `listTeams` — member-only, never public.
      const listTeamAncestors: OrganizationShape["listTeamAncestors"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsEnabled;
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          yield* requireTeam(organizationId, teamId);
          return yield* teams.getAncestors(organizationId, teamId);
        },
      );

      const listTeamDescendants: OrganizationShape["listTeamDescendants"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsEnabled;
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          yield* requireTeam(organizationId, teamId);
          return yield* teams.getDescendants(organizationId, teamId);
        },
      );

      const listTeams: OrganizationShape["listTeams"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsEnabled;
          // MTI-002: any authenticated principal could otherwise enumerate
          // another tenant's team names/counts — member-only, mirroring
          // `getFull`'s own `requireMembership` posture for a read.
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          return yield* teams.listTeamsByOrganization(organizationId);
        },
      );

      const listUserTeams: OrganizationShape["listUserTeams"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsEnabled;
          return yield* teams.listTeamsByUser(organizationId, Users.UserId(caller.ref.id));
        },
      );

      const updateTeam: OrganizationShape["updateTeam"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, name) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsEnabled;
          yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "team",
            "update",
            teamId,
          );
          yield* requireTeam(organizationId, teamId);
          const vetoed = yield* veto(
            "organization.team.update.before",
            beforeUpdateTeam.run({ organizationId, teamId, name }),
          );
          const updated = yield* teams
            .updateTeam(organizationId, teamId, vetoed.name)
            .pipe(
              Effect.catchTag("TeamRecordNotFound", () =>
                Effect.die(new Error("awthaq: team vanished between check and write")),
              ),
            );
          yield* events.publish({ _tag: "auth.organization.teamUpdated", organizationId, teamId });
          yield* afterUpdateTeam.run({ organizationId, teamId, name: vetoed.name });
          return updated;
        },
      );

      const removeTeam: OrganizationShape["removeTeam"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsEnabled;
          yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "team",
            "delete",
            teamId,
          );
          yield* requireTeam(organizationId, teamId);
          const count = yield* teams.countTeamsByOrganization(organizationId);
          if (count <= 1 && !orgConfig.teams.allowRemovingAllTeams) {
            return yield* Effect.fail(new OrganizationApi.LastTeamCannotBeRemoved());
          }
          // OHS-001: refuse before the veto hook runs; the records layer re-checks atomically.
          const below = yield* teams.getDescendants(organizationId, teamId);
          if (below.length > 0) return yield* Effect.fail(new OrganizationApi.TeamHasChildren());
          yield* veto(
            "organization.team.delete.before",
            beforeDeleteTeam.run({ organizationId, teamId }),
          );
          yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                yield* teams.removeTeam(organizationId, teamId).pipe(
                  Effect.catchTags({
                    TeamRecordNotFound: () =>
                      Effect.die(new Error("awthaq: team vanished between check and write")),
                    TeamHasChildren: () => Effect.fail(new OrganizationApi.TeamHasChildren()),
                  }),
                );
                // CWM-003/OHS-007: no session may keep the deleted team active.
                yield* activeContext.clearTeam(teamId);
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
          yield* events.publish({ _tag: "auth.organization.teamDeleted", organizationId, teamId });
          yield* afterDeleteTeam.run({ organizationId, teamId });
        },
      );

      const listTeamMembers: OrganizationShape["listTeamMembers"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsEnabled;
          yield* requireTeam(organizationId, teamId);
          // MTI-002: a team roster is personal data about another tenant's
          // staff — member-only, mirroring `getFull`'s own
          // `requireMembership` posture for a read.
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          return yield* teams.listTeamMembers(teamId);
        },
      );

      const addTeamMember: OrganizationShape["addTeamMember"] = Effect.fnUntraced(function* (
        caller,
        organizationId,
        teamId,
        targetUserId,
        role = ["member"],
      ) {
        yield* requireOrganization(organizationId);
        yield* requireTeamsEnabled;
        const callerId = Users.UserId(caller.ref.id);
        yield* requirePermission(callerId, organizationId, "team", "update", teamId);
        const team = yield* requireTeam(organizationId, teamId);
        yield* requireGrantableTeamRole(callerId, organizationId, teamId, role);
        const targetMembership = yield* members.findByUserAndOrg(targetUserId, organizationId);
        if (Option.isNone(targetMembership)) {
          return yield* Effect.fail(new OrganizationApi.MembershipNotFound());
        }
        if (team.memberCount >= orgConfig.teams.maximumMembersPerTeam) {
          return yield* Effect.fail(new OrganizationApi.TeamMemberLimitReached());
        }
        yield* veto(
          "organization.team.member.add.before",
          beforeAddTeamMember.run({ organizationId, teamId, userId: targetUserId, role }),
        );
        // OHS-003: a second add is refused — it would over-count `memberCount`.
        const onTeam = yield* teams.findTeamMembership(teamId, targetUserId);
        if (Option.isSome(onTeam)) {
          return yield* Effect.fail(new OrganizationApi.AlreadyTeamMember());
        }
        const record = yield* teams
          .addTeamMember({ teamId, userId: targetUserId, role })
          .pipe(
            Effect.catchTag("TeamMembershipRecordAlreadyExists", () =>
              Effect.fail(new OrganizationApi.AlreadyTeamMember()),
            ),
          );
        yield* events.publish({
          _tag: "auth.organization.teamMemberAdded",
          organizationId,
          teamId,
          userId: targetUserId,
        });
        yield* afterAddTeamMember.run({ organizationId, teamId, userId: targetUserId, role });
        return record;
      });

      const updateTeamMemberRole: OrganizationShape["updateTeamMemberRole"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, targetUserId, role) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsEnabled;
          const callerId = Users.UserId(caller.ref.id);
          yield* requirePermission(callerId, organizationId, "team", "update", teamId);
          yield* requireTeam(organizationId, teamId);
          const target = yield* teams.findTeamMembership(teamId, targetUserId);
          if (Option.isNone(target)) {
            return yield* Effect.fail(new OrganizationApi.TeamMembershipNotFound());
          }
          yield* requireGrantableTeamRole(
            callerId,
            organizationId,
            teamId,
            role,
            target.value.role,
          );
          yield* veto(
            "organization.team.member.updateRole.before",
            beforeUpdateTeamMemberRole.run({ organizationId, teamId, userId: targetUserId, role }),
          );
          const updated = yield* teams
            .updateTeamMemberRole(teamId, targetUserId, role)
            .pipe(
              Effect.catchTag("TeamMembershipRecordNotFound", () =>
                Effect.fail(new OrganizationApi.TeamMembershipNotFound()),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.teamMemberRoleUpdated",
            organizationId,
            teamId,
            userId: targetUserId,
            role,
          });
          yield* afterUpdateTeamMemberRole.run({
            organizationId,
            teamId,
            userId: targetUserId,
            role,
          });
          return updated;
        },
      );

      const removeTeamMember: OrganizationShape["removeTeamMember"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, targetUserId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsEnabled;
          yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "team",
            "update",
            teamId,
          );
          yield* requireTeam(organizationId, teamId);
          yield* veto(
            "organization.team.member.remove.before",
            beforeRemoveTeamMember.run({ organizationId, teamId, userId: targetUserId }),
          );
          yield* teams
            .removeTeamMember(teamId, targetUserId)
            .pipe(
              Effect.catchTag("TeamMembershipRecordNotFound", () =>
                Effect.fail(new OrganizationApi.TeamMembershipNotFound()),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.teamMemberRemoved",
            organizationId,
            teamId,
            userId: targetUserId,
          });
          yield* afterRemoveTeamMember.run({ organizationId, teamId, userId: targetUserId });
        },
      );

      const setActiveTeam: OrganizationShape["setActiveTeam"] = Effect.fnUntraced(
        function* (caller, teamId) {
          const callerId = Users.UserId(caller.ref.id);
          if (teamId === null) {
            return yield* activeContext.unsetTeam(caller.sessionId, callerId);
          }
          const membership = yield* teams.findTeamMembership(teamId, callerId);
          if (Option.isNone(membership)) {
            return yield* Effect.fail(new OrganizationApi.TeamMembershipNotFound());
          }
          // MTI-001: the team-membership record is the witness the setter requires.
          return yield* activeContext.setTeam(caller.sessionId, membership.value);
        },
      );

      const attributesFor: OrganizationShape["attributesFor"] = (organizationId, userId) =>
        members
          .findByUserAndOrg(userId, organizationId)
          .pipe(
            Effect.flatMap((membership) =>
              Option.isNone(membership)
                ? Effect.succeed(Option.none())
                : effectivePermissionsOf(organizationId, membership.value).pipe(
                    Effect.map((permissions) =>
                      Option.some({ role: membership.value.role, permissions }),
                    ),
                  ),
            ),
          );

      return Organization.of({
        create,
        checkSlug,
        list,
        get,
        getFull,
        update,
        delete: delete_,
        listMembers,
        removeMember,
        updateMemberRole,
        leave,
        addMember,
        getActiveMember,
        getActiveMemberRole,
        setActive,
        getActive,
        invite,
        acceptInvitation,
        rejectInvitation,
        cancelInvitation,
        getInvitation,
        getInvitationByToken,
        listInvitationsForOrganization,
        listInvitationsForUser,
        createRole,
        listRoles,
        getRole,
        updateRole,
        deleteRole,
        createTeam,
        moveTeam,
        listTeamAncestors,
        listTeamDescendants,
        listTeams,
        listUserTeams,
        updateTeam,
        removeTeam,
        listTeamMembers,
        addTeamMember,
        updateTeamMemberRole,
        removeTeamMember,
        setActiveTeam,
        attributesFor,
      });
    }),
  });
}
