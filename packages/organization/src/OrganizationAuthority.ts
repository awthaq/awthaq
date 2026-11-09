// @awthaq/organization — OrganizationAuthority
//
// The read-only authority module: what a role, a membership or a team role confers. It is the one
// evaluation path (ADR-EA-009): the authorized interface gates its endpoints with it, the system
// modules derive their `Bound` from it, and `OrganizationQadi.relationships` / `attributes` read it,
// so a qadi decision and the plugin's own gating agree by construction.
//
// Nothing here writes, publishes or runs a hook point.

import type { Errors } from "@awthaq/core";
import { Users } from "@awthaq/core";
import { Tenant } from "@awthaq/ports";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as MembershipRecords from "./MembershipRecords.ts";
import * as OrganizationActor from "./OrganizationActor.ts";
import { OrganizationConfig } from "./OrganizationConfig.ts";
import * as OrganizationDirectory from "./OrganizationDirectory.ts";
import * as OrganizationErrors from "./OrganizationErrors.ts";
import * as OrgRoleRecords from "./OrgRoleRecords.ts";
import * as PermissionEngine from "./PermissionEngine.ts";
import * as TeamRecords from "./TeamRecords.ts";

export interface OrganizationAuthorityShape {
  /** Static statements plus, when dynamic access control is enabled, every custom role this organization has defined. */
  readonly statementsByRole: (
    organizationId: string,
  ) => Effect.Effect<ReadonlyMap<string, PermissionEngine.Statements>, Errors.StoreUnavailable>;
  /** What a membership's roles confer in its organization. */
  readonly effectivePermissions: (
    organizationId: string,
    membership: MembershipRecords.MembershipRecord,
  ) => Effect.Effect<PermissionEngine.Statements, Errors.StoreUnavailable>;
  /**
   * OHS-004: the team-role statements a `TeamMembershipRecord` may hold, `member` (nothing) plus whatever
   * `OrganizationConfig.teamStatements` defines, in force for this fiber (EP-007).
   */
  readonly teamRoleStatements: Effect.Effect<ReadonlyMap<string, PermissionEngine.Statements>>;
  /**
   * OHS-004: what the user's *team* roles confer on `teamId`: the statements of every role they hold on that
   * team or any ancestor of it (authority flows down the subtree, never up or sideways). A team outside
   * `organizationId` confers nothing (A-F7).
   */
  readonly teamAuthority: (
    userId: Users.UserId,
    organizationId: string,
    teamId: string,
  ) => Effect.Effect<PermissionEngine.Statements, Errors.StoreUnavailable>;
  /**
   * The statements a member holds in scope: the membership's organization statements, merged with
   * `teamAuthority` on `teamId` when one is named (`undefined` = organization level).
   */
  readonly scopedStatements: (
    organizationId: string,
    membership: MembershipRecords.MembershipRecord,
    teamId: string | undefined,
  ) => Effect.Effect<PermissionEngine.Statements, Errors.StoreUnavailable>;
  /**
   * `scopedStatements` plus the `Bound.Ceiling` over exactly those statements: the only way a member's
   * grant ceiling is minted (RRM-001, OHS-004).
   */
  readonly scopedCeiling: (
    organizationId: string,
    membership: MembershipRecords.MembershipRecord,
    teamId: string | undefined,
  ) => Effect.Effect<
    {
      readonly statements: PermissionEngine.Statements;
      readonly bound: OrganizationActor.Bound;
    },
    Errors.StoreUnavailable
  >;
  /** Pure: whether `statements` hold `wanted` (`PermissionEngine.hasPermission`). */
  readonly holds: (
    statements: PermissionEngine.Statements,
    wanted: { readonly resource: string; readonly action: string },
  ) => boolean;
  /**
   * The relationship/attribute source of `OrganizationQadi` (the old `Organization.attributesFor`): `None`
   * when `userId` is not a member, otherwise their role names and effective statements.
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
  /**
   * BEH-EA-316: `None` when `roles` can be conferred by a source whose most is `ceiling` (role names of this
   * organization). `unknownRole` / `unknownCeiling`: a name this organization does not recognize;
   * `exceedsCeiling`: `roles` hold a statement the ceiling does not.
   */
  readonly checkRoleCeiling: (input: {
    readonly organizationId: string;
    readonly roles: ReadonlyArray<string>;
    readonly ceiling: ReadonlyArray<string>;
  }) => Effect.Effect<
    Option.Option<"unknownRole" | "unknownCeiling" | "exceedsCeiling">,
    OrganizationErrors.OrganizationNotFound | Errors.StoreUnavailable
  >;
  /**
   * `Ceiling(effective(ceiling))` for a source that has no membership (a SAML role mapping): the bound a
   * mapped role set must fit.
   */
  readonly ceilingOf: (
    organizationId: string,
    ceiling: ReadonlyArray<string>,
  ) => Effect.Effect<
    OrganizationActor.Bound,
    OrganizationErrors.UnknownOrgRole | Errors.StoreUnavailable
  >;
}

/**
 * The only constructor of `CeilingStatements` (module-local; `AuthorizationBoundary.test.ts` forbids another):
 * a `Bound.Ceiling` is minted here, for a member's proof (`scopedCeiling`) or an identity provider (`ceilingOf`).
 */
const ceilingStatements = Brand.nominal<OrganizationActor.CeilingStatements>();
const mintCeiling = (statements: PermissionEngine.Statements) =>
  OrganizationActor.Bound.Ceiling({ statements: ceilingStatements(statements) });

export class OrganizationAuthority extends Context.Service<
  OrganizationAuthority,
  OrganizationAuthorityShape
>()("awthaq/plugin/organization/Authority") {
  static readonly layer = Layer.effect(
    OrganizationAuthority,
    Effect.gen(function* () {
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const members = yield* MembershipRecords.MembershipRecords;
      const orgRoles = yield* OrgRoleRecords.OrgRoleRecords;
      const teams = yield* TeamRecords.TeamRecords;
      // EP-007 (ADR-EA-018): the configuration in force is decided per operation, not frozen at layer build.
      const builtConfig = yield* OrganizationConfig;
      const configNow = Tenant.configInForce(OrganizationConfig, builtConfig);

      const statementsByRole: OrganizationAuthorityShape["statementsByRole"] = (organizationId) =>
        Effect.flatMap(configNow, (orgConfig) =>
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
            : Effect.succeed(PermissionEngine.statementsByRoleFrom(orgConfig.permissionStatements)),
        );

      const effectivePermissions: OrganizationAuthorityShape["effectivePermissions"] = (
        organizationId,
        membership,
      ) =>
        statementsByRole(organizationId).pipe(
          Effect.map((byRole) => PermissionEngine.effectivePermissions(membership.role, byRole)),
        );

      const teamRoleStatements: OrganizationAuthorityShape["teamRoleStatements"] = Effect.map(
        configNow,
        (orgConfig): ReadonlyMap<string, PermissionEngine.Statements> =>
          new Map([["member", {}], ...Object.entries(orgConfig.teamStatements)]),
      );

      const teamAuthority: OrganizationAuthorityShape["teamAuthority"] = Effect.fnUntraced(
        function* (userId, organizationId, teamId) {
          // A-F7: the named team itself must belong to this organization (the ancestors are scoped already).
          if (Option.isNone(yield* teams.findTeamById(organizationId, teamId))) return {};
          const roleStatements = yield* teamRoleStatements;
          const ancestors = yield* teams.getAncestors(organizationId, teamId);
          let authority: PermissionEngine.Statements = {};
          for (const id of [teamId, ...ancestors.map((team) => team.id)]) {
            const held = yield* teams.findTeamMembership(id, userId);
            if (Option.isSome(held)) {
              authority = PermissionEngine.mergeStatements(
                authority,
                PermissionEngine.effectivePermissions(held.value.role, roleStatements),
              );
            }
          }
          return authority;
        },
      );

      const scopedStatements: OrganizationAuthorityShape["scopedStatements"] = Effect.fnUntraced(
        function* (organizationId, membership, teamId) {
          const statements = yield* effectivePermissions(organizationId, membership);
          return teamId === undefined
            ? statements
            : PermissionEngine.mergeStatements(
                statements,
                yield* teamAuthority(membership.userId, organizationId, teamId),
              );
        },
      );

      const scopedCeiling: OrganizationAuthorityShape["scopedCeiling"] = (
        organizationId,
        membership,
        teamId,
      ) =>
        scopedStatements(organizationId, membership, teamId).pipe(
          Effect.map((statements) => ({ statements, bound: mintCeiling(statements) })),
        );

      const holds: OrganizationAuthorityShape["holds"] = (statements, wanted) =>
        PermissionEngine.hasPermission(statements, wanted.resource, wanted.action);

      const attributesFor: OrganizationAuthorityShape["attributesFor"] = (organizationId, userId) =>
        members
          .findByUserAndOrg(userId, organizationId)
          .pipe(
            Effect.flatMap((membership) =>
              Option.isNone(membership)
                ? Effect.succeed(Option.none())
                : effectivePermissions(organizationId, membership.value).pipe(
                    Effect.map((permissions) =>
                      Option.some({ role: membership.value.role, permissions }),
                    ),
                  ),
            ),
          );

      const checkRoleCeiling: OrganizationAuthorityShape["checkRoleCeiling"] = Effect.fnUntraced(
        function* ({ organizationId, roles, ceiling }) {
          // EP-003: a suspended organization answers like an unknown one.
          yield* directory.requireActive(organizationId);
          const byRole = yield* statementsByRole(organizationId);
          if (roles.some((name) => !byRole.has(name))) return Option.some("unknownRole" as const);
          if (ceiling.some((name) => !byRole.has(name))) {
            return Option.some("unknownCeiling" as const);
          }
          return PermissionEngine.canGrant(
            PermissionEngine.effectivePermissions(roles, byRole),
            PermissionEngine.effectivePermissions(ceiling, byRole),
          )
            ? Option.none()
            : Option.some("exceedsCeiling" as const);
        },
      );

      const ceilingOf: OrganizationAuthorityShape["ceilingOf"] = Effect.fnUntraced(
        function* (organizationId, ceiling) {
          const byRole = yield* statementsByRole(organizationId);
          if (ceiling.some((name) => !byRole.has(name))) {
            return yield* new OrganizationErrors.UnknownOrgRole();
          }
          return mintCeiling(PermissionEngine.effectivePermissions(ceiling, byRole));
        },
      );

      return OrganizationAuthority.of({
        statementsByRole,
        effectivePermissions,
        teamRoleStatements,
        teamAuthority,
        scopedStatements,
        scopedCeiling,
        holds,
        attributesFor,
        checkRoleCeiling,
        ceilingOf,
      });
    }),
  );
}
