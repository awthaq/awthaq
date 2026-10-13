// @awthaq/organization — OrganizationHandlers
//
// The HTTP handlers of the `organization` group: wire decoding, DTO mapping and a call into the
// authorized interface. Built over a service tag so this file never imports the plugin class.

import { Api } from "@awthaq/api";
import { Users } from "@awthaq/core";
import { Defects } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as ActiveContextRecords from "./ActiveContextRecords.ts";
import * as InvitationRecords from "./InvitationRecords.ts";
import * as MembershipRecords from "./MembershipRecords.ts";
import * as OrganizationApi from "./OrganizationApi.ts";
import type { OrganizationShape } from "./OrganizationShape.ts";
import * as OrganizationRecords from "./OrganizationRecords.ts";
import * as OrgRoleRecords from "./OrgRoleRecords.ts";
import * as TeamRecords from "./TeamRecords.ts";

const toOrganizationDto = (
  record: OrganizationRecords.OrganizationRecord,
): OrganizationApi.OrganizationDto =>
  new OrganizationApi.OrganizationDto({
    id: record.id,
    name: record.name,
    slug: record.slug,
    logo: Option.getOrNull(record.logo),
    metadata: Option.getOrNull(record.metadata),
    homeRegion: Option.getOrNull(record.homeRegion),
    suspended: Option.isSome(record.suspendedAt),
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
    return yield* Defects.invariantViolation(
      "NonUserPrincipal",
      `awthaq: organization group reached with a non-User principal: ${principal._tag}`,
    );
  }
  return principal;
});

const parseIntQuery = (value: string | undefined): number | undefined =>
  value === undefined ? undefined : Number.parseInt(value, 10);

// ---- handlers -------------------------------------------------------------------

/**
 * The `organization` group's handlers, built over the plugin's own service tag (the class lives in
 * `Organization.ts`, which imports this file, so the tag is passed in rather than imported).
 */
export const make = <Self>(tag: Context.Service<Self, OrganizationShape>) =>
  HttpApiBuilder.group(
    OrganizationApi.OrganizationApi,
    "organization",
    Effect.fnUntraced(function* (handlers) {
      const organization = yield* tag;
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
        getRole: Effect.fnUntraced(function* ({
          params,
        }: {
          params: OrganizationApi.OrgRoleParams;
        }) {
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
