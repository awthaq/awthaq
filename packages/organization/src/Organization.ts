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
import { AuthEvents, AuthPlugin, HookPoint, Hooks, Migrations, Users } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import * as Context from "effect/Context";
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
  invitationExpiresIn: Duration.hours(48),
  invitationLimit: 100,
  cancelPendingInvitationsOnReInvite: false,
  requireEmailVerificationOnInvitation: false,
};

export const OrganizationConfig: Context.Reference<OrganizationConfigShape> = Context.Reference(
  "awthaq/organization/Config",
  { defaultValue: () => defaultOrganizationConfig },
);

export const config = (partial: Partial<OrganizationConfigShape>) =>
  Layer.succeed(OrganizationConfig, { ...defaultOrganizationConfig, ...partial });

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
  readonly get: (
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
    | OrganizationApi.MembershipLimitReached
    | OrganizationApi.TeamsDisabled
    | OrganizationApi.TeamNotFound
    | HookPoint.HookAborted
  >;
  readonly acceptInvitation: (
    caller: Api.UserPrincipal,
    invitationId: string,
  ) => Effect.Effect<
    MembershipRecords.MembershipRecord,
    | OrganizationApi.InvitationNotFound
    | OrganizationApi.InvitationNotPending
    | OrganizationApi.InvitationExpired
    | OrganizationApi.InvitationEmailMismatch
    | OrganizationApi.MembershipLimitReached
    | OrganizationApi.EmailVerificationRequired
    | OrganizationApi.TeamMemberLimitReached
    | HookPoint.HookAborted
  >;
  readonly rejectInvitation: (
    caller: Api.UserPrincipal,
    invitationId: string,
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
  readonly getInvitation: (
    invitationId: string,
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
  readonly createTeam: (
    caller: Api.UserPrincipal,
    organizationId: string,
    name: string,
  ) => Effect.Effect<
    TeamRecords.TeamRecord,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.TeamsDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.TeamLimitReached
    | HookPoint.HookAborted
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
  ) => Effect.Effect<
    TeamRecords.TeamMembershipRecord,
    | OrganizationApi.OrganizationNotFound
    | OrganizationApi.TeamsDisabled
    | OrganizationApi.OrganizationPermissionDenied
    | OrganizationApi.TeamNotFound
    | OrganizationApi.MembershipNotFound
    | OrganizationApi.TeamMemberLimitReached
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
        const record = yield* organization.get(params.organizationId);
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
        const record = yield* organization.getInvitation(params.invitationId);
        return toInvitationDto(record);
      }),
      acceptInvitation: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.InvitationIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        const record = yield* organization.acceptInvitation(caller, params.invitationId);
        return toMembershipDto(record);
      }),
      rejectInvitation: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.InvitationIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        yield* organization.rejectInvitation(caller, params.invitationId);
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
        const record = yield* organization.createTeam(caller, params.organizationId, payload.name);
        return toTeamDto(record);
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
 * fixtures — no new uniqueness constraint is added beyond what each
 * table's own tests already exercise, since that's a design question
 * (BAM-002's own ask is DDL parity, not a fresh constraint audit).
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
            createdAt TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_org (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            logo TEXT,
            metadata TEXT,
            createdAt TEXT NOT NULL
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
            userId TEXT NOT NULL,
            organizationId TEXT NOT NULL,
            role TEXT NOT NULL,
            createdAt TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_membership (
            id TEXT PRIMARY KEY,
            userId TEXT NOT NULL,
            organizationId TEXT NOT NULL,
            role TEXT NOT NULL,
            createdAt TEXT NOT NULL
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
          sql`CREATE INDEX organization_membership_organization_id ON organization_membership(organizationId)`.pipe(
            Effect.andThen(
              sql`CREATE INDEX organization_membership_user_id ON organization_membership(userId)`,
            ),
          ),
        sqlite: () =>
          sql`CREATE INDEX organization_membership_organization_id ON organization_membership(organizationId)`.pipe(
            Effect.andThen(
              sql`CREATE INDEX organization_membership_user_id ON organization_membership(userId)`,
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
            inviterId TEXT NOT NULL,
            organizationId TEXT NOT NULL,
            teamId TEXT,
            role TEXT NOT NULL,
            status TEXT NOT NULL,
            createdAt TIMESTAMPTZ NOT NULL,
            expiresAt TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_invitation (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            inviterId TEXT NOT NULL,
            organizationId TEXT NOT NULL,
            teamId TEXT,
            role TEXT NOT NULL,
            status TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            expiresAt TEXT NOT NULL
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
          sql`CREATE INDEX organization_invitation_organization_id ON organization_invitation(organizationId)`.pipe(
            Effect.andThen(
              sql`CREATE INDEX organization_invitation_email ON organization_invitation(email)`,
            ),
            Effect.andThen(
              sql`CREATE INDEX organization_invitation_inviter_id ON organization_invitation(inviterId)`,
            ),
          ),
        sqlite: () =>
          sql`CREATE INDEX organization_invitation_organization_id ON organization_invitation(organizationId)`.pipe(
            Effect.andThen(
              sql`CREATE INDEX organization_invitation_email ON organization_invitation(email)`,
            ),
            Effect.andThen(
              sql`CREATE INDEX organization_invitation_inviter_id ON organization_invitation(inviterId)`,
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
            organizationId TEXT NOT NULL,
            memberCount INTEGER NOT NULL,
            createdAt TIMESTAMPTZ NOT NULL,
            updatedAt TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_team (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            organizationId TEXT NOT NULL,
            memberCount INTEGER NOT NULL,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
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
          sql`CREATE INDEX organization_team_organization_id ON organization_team(organizationId)`,
        sqlite: () =>
          sql`CREATE INDEX organization_team_organization_id ON organization_team(organizationId)`,
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
            teamId TEXT NOT NULL,
            userId TEXT NOT NULL,
            createdAt TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_team_membership (
            id TEXT PRIMARY KEY,
            teamId TEXT NOT NULL,
            userId TEXT NOT NULL,
            createdAt TEXT NOT NULL
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
          sql`CREATE INDEX organization_team_membership_team_id ON organization_team_membership(teamId)`,
        sqlite: () =>
          sql`CREATE INDEX organization_team_membership_team_id ON organization_team_membership(teamId)`,
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
            organizationId TEXT NOT NULL,
            role TEXT NOT NULL,
            permission TEXT NOT NULL,
            createdAt TIMESTAMPTZ NOT NULL,
            updatedAt TIMESTAMPTZ NOT NULL,
            UNIQUE(organizationId, role)
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_role (
            id TEXT PRIMARY KEY,
            organizationId TEXT NOT NULL,
            role TEXT NOT NULL,
            permission TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            UNIQUE(organizationId, role)
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
            sessionId TEXT PRIMARY KEY,
            activeOrganizationId TEXT,
            activeTeamId TEXT,
            updatedAt TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_active_context (
            sessionId TEXT PRIMARY KEY,
            activeOrganizationId TEXT,
            activeTeamId TEXT,
            updatedAt TEXT NOT NULL
          )`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
];

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
      "organization_role",
      "organization_active_context",
    ],
  },
) {
  static readonly layer = AuthPlugin.layer(Organization, {
    handlers: OrganizationHandlers,
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
      const beforeDeleteTeam = yield* OrganizationHooks.BeforeDeleteTeam;
      const afterDeleteTeam = yield* OrganizationHooks.AfterDeleteTeam;
      const beforeAddTeamMember = yield* OrganizationHooks.BeforeAddTeamMember;
      const afterAddTeamMember = yield* OrganizationHooks.AfterAddTeamMember;
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

      /** Fails `OrganizationPermissionDenied` if the caller isn't a member, or lacks the requested statement. */
      const requirePermission = (
        callerId: Users.UserId,
        organizationId: string,
        resource: string,
        action: string,
      ) =>
        Effect.gen(function* () {
          const membership = yield* members.findByUserAndOrg(callerId, organizationId);
          if (Option.isNone(membership)) {
            return yield* Effect.fail(new OrganizationApi.OrganizationPermissionDenied());
          }
          const effective = yield* effectivePermissionsOf(organizationId, membership.value);
          if (!PermissionEngine.hasPermission(effective, resource, action)) {
            return yield* Effect.fail(new OrganizationApi.OrganizationPermissionDenied());
          }
          return membership.value;
        });

      /** Fails `OrganizationPermissionDenied` if the caller isn't a member — no statement check, for read endpoints any member may use. */
      const requireMembership = (callerId: Users.UserId, organizationId: string) =>
        members.findByUserAndOrg(callerId, organizationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationApi.OrganizationPermissionDenied()),
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
        const membership = yield* members.create({
          userId: callerId,
          organizationId: record.id,
          role: [orgConfig.creatorRole],
        });
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

      const get: OrganizationShape["get"] = (organizationId) => requireOrganization(organizationId);

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
          yield* members.removeAllForOrganization(organizationId);
          yield* invitations.removeAllForOrganization(organizationId);
          yield* teams.removeAllTeamsForOrganization(organizationId);
          yield* orgRoles.removeAllForOrganization(organizationId);
          yield* orgs
            .delete(organizationId)
            .pipe(
              Effect.catchTag("OrganizationRecordNotFound", () =>
                Effect.die(new Error("awthaq: organization vanished between check and write")),
              ),
            );
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

      const removeMember: OrganizationShape["removeMember"] = Effect.fnUntraced(
        function* (caller, organizationId, targetUserId) {
          yield* requireOrganization(organizationId);
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
          yield* members
            .remove(targetUserId, organizationId)
            .pipe(
              Effect.catchTag("MembershipRecordNotFound", () =>
                Effect.die(new Error("awthaq: membership vanished between check and write")),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.memberRemoved",
            organizationId,
            userId: targetUserId,
          });
          yield* afterRemove.run({ organizationId, userId: targetUserId });
        },
      );

      const updateMemberRole: OrganizationShape["updateMemberRole"] = Effect.fnUntraced(
        function* (caller, organizationId, targetUserId, role) {
          yield* requireOrganization(organizationId);
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

          yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "member", "update");
          const vetoed = yield* veto(
            "organization.member.updateRole.before",
            beforeUpdateRole.run({ organizationId, userId: targetUserId, role }),
          );
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

          yield* members
            .remove(callerId, organizationId)
            .pipe(
              Effect.catchTag("MembershipRecordNotFound", () =>
                Effect.die(new Error("awthaq: membership vanished between check and write")),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.memberRemoved",
            organizationId,
            userId: callerId,
          });
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
        const membership = yield* members.create({ userId, organizationId, role: vetoed.role });
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
          if (organizationId !== null) {
            const membership = yield* members.findByUserAndOrg(
              Users.UserId(caller.ref.id),
              organizationId,
            );
            if (Option.isNone(membership))
              return yield* Effect.fail(new OrganizationApi.MembershipNotFound());
          }
          return yield* activeContext.setOrganization(caller.sessionId, organizationId);
        },
      );

      const getActive: OrganizationShape["getActive"] = Effect.fnUntraced(function* (caller) {
        const existing = yield* activeContext.findBySessionId(caller.sessionId);
        if (Option.isSome(existing)) return existing.value;
        const now = yield* DateTime.now;
        const empty: ActiveContextRecords.ActiveContextRecord = {
          sessionId: caller.sessionId,
          activeOrganizationId: Option.none(),
          activeTeamId: Option.none(),
          updatedAt: now,
        };
        return empty;
      });

      // ---- invitations --------------------------------------------------------

      const invite: OrganizationShape["invite"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          yield* requireOrganization(organizationId);
          const callerId = Users.UserId(caller.ref.id);
          yield* requirePermission(callerId, organizationId, "invitation", "create");

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

          if (Option.isSome(alreadyMember) && Option.isSome(existing)) {
            yield* invitations.updateStatus(existing.value.id, "canceled").pipe(Effect.orDie);
          }

          const expiresAt = yield* DateTime.now.pipe(
            Effect.map((now) => DateTime.addDuration(now, orgConfig.invitationExpiresIn)),
          );

          const sendInvite = (record: InvitationRecords.InvitationRecord) =>
            mailer.send({
              to: record.email,
              template: "organization-invite",
              data: { token: record.id, organizationId, role: record.role },
            });

          if (Option.isNone(alreadyMember) && Option.isSome(existing)) {
            if (orgConfig.cancelPendingInvitationsOnReInvite) {
              yield* invitations.updateStatus(existing.value.id, "canceled").pipe(Effect.orDie);
            } else if (input.resend) {
              yield* sendInvite(existing.value);
              yield* events.publish({
                _tag: "auth.organization.invitationCreated",
                invitationId: existing.value.id,
                organizationId,
                email: existing.value.email,
              });
              return existing.value;
            } else {
              return existing.value;
            }
          }

          const record = yield* invitations.create({
            email: vetoed.email,
            inviterId: callerId,
            organizationId,
            teamId: input.teamId,
            role: vetoed.role,
            expiresAt,
          });
          yield* sendInvite(record);
          yield* events.publish({
            _tag: "auth.organization.invitationCreated",
            invitationId: record.id,
            organizationId,
            email: record.email,
          });
          yield* afterCreateInvitation.run({
            organizationId,
            email: record.email,
            role: vetoed.role,
            invitationId: record.id,
          });
          return record;
        },
      );

      const requirePendingInvitation = (invitationId: string) =>
        invitations.findById(invitationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationApi.InvitationNotFound()),
              onSome: Effect.succeed,
            }),
          ),
          Effect.flatMap((record) =>
            record.status === "pending"
              ? Effect.succeed(record)
              : Effect.fail(new OrganizationApi.InvitationNotPending()),
          ),
        );

      const acceptInvitation: OrganizationShape["acceptInvitation"] = Effect.fnUntraced(
        function* (caller, invitationId) {
          yield* veto("organization.invitation.accept.before", beforeAccept.run({ invitationId }));

          const record = yield* requirePendingInvitation(invitationId);

          const now = yield* DateTime.now;
          if (DateTime.isGreaterThan(now, record.expiresAt)) {
            yield* invitations.updateStatus(invitationId, "expired").pipe(Effect.orDie);
            return yield* Effect.fail(new OrganizationApi.InvitationExpired());
          }

          const callerId = Users.UserId(caller.ref.id);
          const user = yield* users.findById(callerId).pipe(Effect.orDie);
          if (user.email !== record.email) {
            return yield* Effect.fail(new OrganizationApi.InvitationEmailMismatch());
          }
          if (orgConfig.requireEmailVerificationOnInvitation && !user.emailVerified) {
            return yield* Effect.fail(new OrganizationApi.EmailVerificationRequired());
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

          const membership = yield* members.create({
            userId: callerId,
            organizationId: record.organizationId,
            role: record.role,
          });
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
            yield* teams.addTeamMember({ teamId, userId: callerId });
            yield* events.publish({
              _tag: "auth.organization.teamMemberAdded",
              organizationId: record.organizationId,
              teamId,
              userId: callerId,
            });
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
        function* (caller, invitationId) {
          yield* veto("organization.invitation.reject.before", beforeReject.run({ invitationId }));

          const record = yield* requirePendingInvitation(invitationId);
          const callerId = Users.UserId(caller.ref.id);
          const user = yield* users.findById(callerId).pipe(Effect.orDie);
          if (user.email !== record.email) {
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

          const record = yield* requirePendingInvitation(invitationId);
          yield* requirePermission(
            Users.UserId(caller.ref.id),
            record.organizationId,
            "invitation",
            "cancel",
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

      const getInvitation: OrganizationShape["getInvitation"] = (invitationId) =>
        invitations.findById(invitationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationApi.InvitationNotFound()),
              onSome: Effect.succeed,
            }),
          ),
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
        function* (caller, organizationId, name) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsEnabled;
          yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "team", "create");
          const count = yield* teams.countTeamsByOrganization(organizationId);
          if (count >= orgConfig.teams.maximumTeams) {
            return yield* Effect.fail(new OrganizationApi.TeamLimitReached());
          }
          const vetoed = yield* veto(
            "organization.team.create.before",
            beforeCreateTeam.run({ organizationId, name }),
          );
          const record = yield* teams.createTeam({ organizationId, name: vetoed.name });
          yield* events.publish({
            _tag: "auth.organization.teamCreated",
            organizationId,
            teamId: record.id,
          });
          yield* afterCreateTeam.run({ organizationId, name: vetoed.name, teamId: record.id });
          return record;
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
          yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "team", "update");
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
          yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "team", "delete");
          yield* requireTeam(organizationId, teamId);
          const count = yield* teams.countTeamsByOrganization(organizationId);
          if (count <= 1 && !orgConfig.teams.allowRemovingAllTeams) {
            return yield* Effect.fail(new OrganizationApi.LastTeamCannotBeRemoved());
          }
          yield* veto(
            "organization.team.delete.before",
            beforeDeleteTeam.run({ organizationId, teamId }),
          );
          yield* teams
            .removeTeam(organizationId, teamId)
            .pipe(
              Effect.catchTag("TeamRecordNotFound", () =>
                Effect.die(new Error("awthaq: team vanished between check and write")),
              ),
            );
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

      const addTeamMember: OrganizationShape["addTeamMember"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, targetUserId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsEnabled;
          yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "team", "update");
          const team = yield* requireTeam(organizationId, teamId);
          const targetMembership = yield* members.findByUserAndOrg(targetUserId, organizationId);
          if (Option.isNone(targetMembership)) {
            return yield* Effect.fail(new OrganizationApi.MembershipNotFound());
          }
          if (team.memberCount >= orgConfig.teams.maximumMembersPerTeam) {
            return yield* Effect.fail(new OrganizationApi.TeamMemberLimitReached());
          }
          yield* veto(
            "organization.team.member.add.before",
            beforeAddTeamMember.run({ organizationId, teamId, userId: targetUserId }),
          );
          const record = yield* teams.addTeamMember({ teamId, userId: targetUserId });
          yield* events.publish({
            _tag: "auth.organization.teamMemberAdded",
            organizationId,
            teamId,
            userId: targetUserId,
          });
          yield* afterAddTeamMember.run({ organizationId, teamId, userId: targetUserId });
          return record;
        },
      );

      const removeTeamMember: OrganizationShape["removeTeamMember"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, targetUserId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsEnabled;
          yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "team", "update");
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
          if (teamId !== null) {
            const membership = yield* teams.findTeamMembership(teamId, Users.UserId(caller.ref.id));
            if (Option.isNone(membership)) {
              return yield* Effect.fail(new OrganizationApi.TeamMembershipNotFound());
            }
          }
          return yield* activeContext.setTeam(caller.sessionId, teamId);
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
        listInvitationsForOrganization,
        listInvitationsForUser,
        createRole,
        listRoles,
        getRole,
        updateRole,
        deleteRole,
        createTeam,
        listTeams,
        listUserTeams,
        updateTeam,
        removeTeam,
        listTeamMembers,
        addTeamMember,
        removeTeamMember,
        setActiveTeam,
        attributesFor,
      });
    }),
  });
}

/**
 * CSG-001/DRS-002 (.issues/high): a real tap on the core
 * `Hooks.BeforeUserDelete` veto point (CSG-002) that sweeps this plugin's
 * own `organization_membership` rows for the deleted user.
 * `MembershipRecords` is resolved once at layer-build time so the tap
 * handler carries no further service requirement, matching `VetoTap`'s
 * own fixed-`R` signature.
 *
 * **A separate export, not merged into `Organization.layer` itself** —
 * see `@awthaq/passkey`'s own `beforeUserDeleteErasure` for why:
 * `Hooks.BeforeUserDelete`'s tap registry is a module-level singleton
 * that freezes permanently after its first `run()` (BEH-EA-024,
 * empirically confirmed per CSG-002's own resolution comment), so
 * merging a tap into a `Layer` rebuilt repeatedly across a test suite
 * would die with `HookPointFrozen` once the point has run anywhere in
 * the same process. A composition provides
 * `Organization.beforeUserDeleteErasure` once, application-wide — the
 * same opt-in posture `RateLimits.layer`/`Slots.layer` already use.
 *
 * Deliberately scoped to membership only in this pass —
 * `organization_team_membership` and `organization_invitation` (the
 * latter matched by both `inviterId` and the deleted user's own email)
 * are real, still-open gaps this same mechanism can close, tracked as
 * explicit follow-up rather than silently left undone (CSG-001's own
 * resolution comment).
 */
export const beforeUserDeleteErasure: Layer.Layer<
  never,
  never,
  MembershipRecords.MembershipRecords
> = Layer.unwrap(
  Effect.gen(function* () {
    const membershipRecords = yield* MembershipRecords.MembershipRecords;
    return Hooks.BeforeUserDelete.tap((input) =>
      membershipRecords.deleteAllByUser(Users.UserId(input.id)).pipe(Effect.as(input)),
    );
  }),
);
