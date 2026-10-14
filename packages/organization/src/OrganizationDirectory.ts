// @awthaq/organization — OrganizationDirectory
//
// The organization row and its lifecycle as a system interface (ADR-EA-040): creating one (with its
// creator's membership), updating it, deleting it with its cascade, and suspending and reinstating
// it. Every mutation takes an explicit `Actor`, and `suspend` / `reinstate` take a
// `PlatformAdminActor`: the type restricts who can construct the call, the platform administrator's
// own gate (`@awthaq/admin`) has already decided whether they may.
//
// What each operation means lives here once, for every caller (the HTTP endpoints, AdminTenants,
// application code): guards, the veto point, one transaction, events, the observe point. A
// platform suspension is therefore observable (it fires `AfterSuspendOrganization`), so a
// long-lived decision cache never keeps answering for a suspended organization (BEH-EA-237).

import { AuthEvents, Errors, HookPoint, Users } from "@awthaq/core";
import { Defects, SqlTransaction, Tenant } from "@awthaq/ports";
import { TenantScoped } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ActiveContextRecords from "./ActiveContextRecords.ts";
import * as InvitationRecords from "./InvitationRecords.ts";
import * as MembershipRecords from "./MembershipRecords.ts";
import * as OrganizationActor from "./OrganizationActor.ts";
import { OrganizationConfig } from "./OrganizationConfig.ts";
import * as OrganizationDeletion from "./OrganizationDeletion.ts";
import * as OrganizationErrors from "./OrganizationErrors.ts";
import * as OrganizationHooks from "./OrganizationHooks.ts";
import * as OrganizationRecords from "./OrganizationRecords.ts";
import * as OrgRoleRecords from "./OrgRoleRecords.ts";
import * as TeamRecords from "./TeamRecords.ts";

export type Organization = OrganizationRecords.OrganizationRecord;

/** A caller's own memberships, whichever organizations they are in. */
const ownMembershipsGrant = TenantScoped.crossTenant(
  "organization directory: a user's own memberships and their organizations, keyed by the caller's identity",
);
/** Suspension and the platform listing are platform state, not a tenant's. */
const platformGrant = TenantScoped.crossTenant(
  "organization directory: suspension and the platform listing are the platform administrator's, across every tenant (EP-003)",
);

export interface OrganizationDirectoryShape {
  /** Raw: an unknown id is `None`; a suspended organization is `Some` (tenant middleware, AdminTenants, SAML admin). */
  readonly find: (
    organizationId: string,
  ) => Effect.Effect<Option.Option<Organization>, Errors.StoreUnavailable>;
  /** `None` for an unknown OR suspended organization (BEH-EA-237): the SCIM and SAML token gates, qadi, active context. */
  readonly findActive: (
    organizationId: string,
  ) => Effect.Effect<Option.Option<Organization>, Errors.StoreUnavailable>;
  /** `findActive`, failing with the MTI-009 answer. */
  readonly requireActive: (
    organizationId: string,
  ) => Effect.Effect<
    Organization,
    OrganizationErrors.OrganizationNotFound | Errors.StoreUnavailable
  >;
  readonly isSlugAvailable: (slug: string) => Effect.Effect<boolean, Errors.StoreUnavailable>;
  /** The organizations a user belongs to (a suspended one is flagged by `suspendedAt`). */
  readonly listForUser: (
    userId: Users.UserId,
  ) => Effect.Effect<ReadonlyArray<Organization>, Errors.StoreUnavailable>;
  /** EP-003: the platform listing, keyset on `(createdAt, id)`. */
  readonly listPage: (input: {
    readonly after: Option.Option<{ readonly createdAt: DateTime.Utc; readonly id: string }>;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<Organization>, Errors.StoreUnavailable>;

  /**
   * BEH-EA-283: a known region, `organizationLimit` over `owner`'s owned organizations, the veto, then ONE
   * transaction for the organization and the creator's membership (a failed creation leaves neither),
   * `created`, `memberAdded`, `AfterCreateOrganization` and `AfterAddMember`. Who may create at all
   * (`allowUserToCreateOrganization`) is the authorized layer's.
   */
  readonly create: (
    actor: OrganizationActor.Actor,
    input: {
      readonly owner: Users.UserId;
      readonly name: string;
      readonly slug: string;
      readonly logo?: string | undefined;
      readonly metadata?: string | undefined;
      readonly homeRegion?: string | undefined;
    },
  ) => Effect.Effect<
    Organization,
    | OrganizationErrors.OrganizationSlugTaken
    | OrganizationErrors.OrganizationLimitReached
    | OrganizationErrors.UnknownRegion
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly update: (
    actor: OrganizationActor.Actor,
    input: {
      readonly organizationId: string;
      readonly name?: string | undefined;
      readonly slug?: string | undefined;
      readonly logo?: string | null | undefined;
      readonly metadata?: string | null | undefined;
      readonly homeRegion?: string | null | undefined;
    },
  ) => Effect.Effect<
    Organization,
    | OrganizationErrors.OrganizationNotFound
    | OrganizationErrors.OrganizationSlugTaken
    | OrganizationErrors.UnknownRegion
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /**
   * `disableOrganizationDeletion`, the veto, then ONE transaction removing members, invitations, teams,
   * roles, every session's active pointer and the organization; after it, `deleted` and the observe point.
   */
  readonly delete: (
    actor: OrganizationActor.Actor,
    input: { readonly organizationId: string },
  ) => Effect.Effect<
    void,
    | OrganizationErrors.OrganizationNotFound
    | OrganizationErrors.OrganizationDeletionDisabled
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /**
   * EP-003/BEH-EA-237: idempotent (the first `suspendedAt` is kept), with the veto and observe points, and
   * publishing `auth.admin.organizationSuspended` (the audited tag is unchanged). Only a platform
   * administrator may be the actor.
   */
  readonly suspend: (
    actor: OrganizationActor.PlatformAdminActor,
    input: { readonly organizationId: string; readonly reason?: string | undefined },
  ) => Effect.Effect<
    Organization,
    OrganizationErrors.OrganizationNotFound | HookPoint.HookAborted | Errors.StoreUnavailable
  >;
  readonly reinstate: (
    actor: OrganizationActor.PlatformAdminActor,
    input: { readonly organizationId: string },
  ) => Effect.Effect<
    Organization,
    OrganizationErrors.OrganizationNotFound | HookPoint.HookAborted | Errors.StoreUnavailable
  >;
}

export class OrganizationDirectory extends Context.Service<
  OrganizationDirectory,
  OrganizationDirectoryShape
>()("awthaq/plugin/organization/Directory") {
  static readonly layer = Layer.effect(
    OrganizationDirectory,
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const orgs = yield* OrganizationRecords.OrganizationRecords;
      const members = yield* MembershipRecords.MembershipRecords;
      const activeContext = yield* ActiveContextRecords.ActiveContextRecords;
      const invitations = yield* InvitationRecords.InvitationRecords;
      const orgRoles = yield* OrgRoleRecords.OrgRoleRecords;
      const teams = yield* TeamRecords.TeamRecords;
      const sqlTransaction = yield* SqlTransaction.SqlTransaction;
      const deletion = yield* OrganizationDeletion.OrganizationDeletion;
      const builtConfig = yield* OrganizationConfig;
      const configNow = Tenant.configInForce(OrganizationConfig, builtConfig);
      const beforeCreate = yield* OrganizationHooks.BeforeCreateOrganization;
      const afterCreate = yield* OrganizationHooks.AfterCreateOrganization;
      const beforeUpdate = yield* OrganizationHooks.BeforeUpdateOrganization;
      const afterUpdate = yield* OrganizationHooks.AfterUpdateOrganization;
      const beforeDelete = yield* OrganizationHooks.BeforeDeleteOrganization;
      const afterDelete = yield* OrganizationHooks.AfterDeleteOrganization;
      const beforeSuspend = yield* OrganizationHooks.BeforeSuspendOrganization;
      const afterSuspend = yield* OrganizationHooks.AfterSuspendOrganization;
      const beforeReinstate = yield* OrganizationHooks.BeforeReinstateOrganization;
      const afterReinstate = yield* OrganizationHooks.AfterReinstateOrganization;
      const afterAddMember = yield* OrganizationHooks.AfterAddMember;

      const find: OrganizationDirectoryShape["find"] = (organizationId) =>
        orgs.findById(organizationId);

      const findActive: OrganizationDirectoryShape["findActive"] = (organizationId) =>
        orgs
          .findById(organizationId)
          .pipe(Effect.map(Option.filter((record) => Option.isNone(record.suspendedAt))));

      const requireActive: OrganizationDirectoryShape["requireActive"] = (organizationId) =>
        findActive(organizationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationErrors.OrganizationNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        );

      /** DRS-007: a `homeRegion` must come from the configured vocabulary. */
      const requireKnownRegion = (region: string | null | undefined) =>
        Effect.flatMap(configNow, (orgConfig) =>
          region === undefined || region === null || orgConfig.regions.includes(region)
            ? Effect.void
            : Effect.fail(new OrganizationErrors.UnknownRegion({ region })),
        );

      const isSlugAvailable: OrganizationDirectoryShape["isSlugAvailable"] = (slug) =>
        orgs.findBySlug(slug).pipe(Effect.map(Option.isNone));

      const listForUser: OrganizationDirectoryShape["listForUser"] = (userId) =>
        members.listByUser(ownMembershipsGrant, userId).pipe(
          Effect.flatMap((rows) =>
            orgs.listByIds(
              ownMembershipsGrant,
              rows.map((row) => row.organizationId),
            ),
          ),
        );

      const listPage: OrganizationDirectoryShape["listPage"] = (input) =>
        orgs.listPage(platformGrant, input);

      const create: OrganizationDirectoryShape["create"] = Effect.fnUntraced(
        function* (actor, input) {
          const { owner, name, slug, logo, metadata, homeRegion } = input;
          const orgConfig = yield* configNow;
          yield* requireKnownRegion(homeRegion);
          const owned = yield* members.listByUser(ownMembershipsGrant, owner);
          const ownedCount = owned.filter((m) => m.role.includes(orgConfig.creatorRole)).length;
          if (ownedCount >= orgConfig.organizationLimit) {
            return yield* new OrganizationErrors.OrganizationLimitReached();
          }
          const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeCreateOrganization)(
            beforeCreate.run({ actor, callerId: owner, name, slug }),
          );
          // D3: the organization and its creator's membership are one unit, so there is never an
          // organization nobody belongs to (BEH-EA-283).
          const { record, membership } = yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                const created = yield* orgs
                  .create({ name: vetoed.name, slug: vetoed.slug, logo, metadata, homeRegion })
                  .pipe(
                    Effect.catchTag("OrganizationRecordSlugTaken", () =>
                      Effect.fail(new OrganizationErrors.OrganizationSlugTaken()),
                    ),
                  );
                const first = yield* members
                  .create({
                    userId: owner,
                    organizationId: created.id,
                    role: [orgConfig.creatorRole],
                  })
                  .pipe(
                    // A brand-new organization has no memberships, so this cannot collide.
                    Effect.catchTag("MembershipRecordAlreadyExists", Effect.die),
                    // A backend without transactions (`layerNoop`) cannot roll back: remove the
                    // organization again so a failed creation leaves nothing behind.
                    Effect.onError(() => Effect.ignore(orgs.delete(created.id))),
                  );
                return { record: created, membership: first };
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
          yield* events.publish({
            _tag: "auth.organization.created",
            actorUserId: OrganizationActor.userIdOf(actor),
            organizationId: record.id,
            creatorUserId: owner,
          });
          yield* events.publish({
            _tag: "auth.organization.memberAdded",
            actorUserId: OrganizationActor.userIdOf(actor),
            organizationId: record.id,
            userId: owner,
            role: membership.role,
          });
          yield* afterCreate.run({
            actor,
            callerId: owner,
            name: vetoed.name,
            slug: vetoed.slug,
            organizationId: record.id,
          });
          // D7: a membership created here is observable like any other.
          yield* afterAddMember.run({
            actor,
            organizationId: record.id,
            userId: owner,
            role: membership.role,
          });
          return record;
        },
      );

      const update: OrganizationDirectoryShape["update"] = Effect.fnUntraced(
        function* (actor, input) {
          const { organizationId, ...changes } = input;
          yield* requireActive(organizationId);
          yield* requireKnownRegion(changes.homeRegion);
          const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeUpdateOrganization)(
            beforeUpdate.run({ actor, organizationId, name: changes.name, slug: changes.slug }),
          );
          const record = yield* orgs
            .update(organizationId, { ...changes, name: vetoed.name, slug: vetoed.slug })
            .pipe(
              Effect.catchTag("OrganizationRecordNotFound", () =>
                Defects.invariantViolation(
                  "RowVanished",
                  "awthaq: organization vanished between check and write",
                ),
              ),
              Effect.catchTag("OrganizationRecordSlugTaken", () =>
                Effect.fail(new OrganizationErrors.OrganizationSlugTaken()),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.updated",
            actorUserId: OrganizationActor.userIdOf(actor),
            organizationId,
          });
          yield* afterUpdate.run({ actor, organizationId, name: vetoed.name, slug: vetoed.slug });
          return record;
        },
      );

      const remove: OrganizationDirectoryShape["delete"] = Effect.fnUntraced(
        function* (actor, input) {
          const { organizationId } = input;
          yield* requireActive(organizationId);
          if ((yield* configNow).disableOrganizationDeletion) {
            return yield* new OrganizationErrors.OrganizationDeletionDisabled();
          }
          yield* HookPoint.aborted(OrganizationHooks.BeforeDeleteOrganization)(
            beforeDelete.run({ actor, organizationId }),
          );
          // F7: rows other plugins hang off the organization (connections) go in the same transaction.
          const contributions = yield* deletion.contributions;
          // OHS-002: the five-table cascade is one transaction: a failure at any step leaves every
          // organization_* row untouched. Events and hooks only run once the delete has committed.
          yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                yield* members.removeAllForOrganization(organizationId);
                yield* invitations.removeAllForOrganization(organizationId);
                yield* teams.removeAllTeamsForOrganization(organizationId);
                yield* orgRoles.removeAllForOrganization(organizationId);
                // CWM-003: no session may keep pointing at the deleted organization.
                yield* activeContext.clearOrganization(organizationId);
                for (const contribution of contributions) {
                  yield* contribution.handler.inTransaction(organizationId);
                }
                yield* orgs
                  .delete(organizationId)
                  .pipe(
                    Effect.catchTag("OrganizationRecordNotFound", () =>
                      Defects.invariantViolation(
                        "RowVanished",
                        "awthaq: organization vanished between check and write",
                      ),
                    ),
                  );
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
          yield* events.publish({
            _tag: "auth.organization.deleted",
            actorUserId: OrganizationActor.userIdOf(actor),
            organizationId,
          });
          for (const contribution of contributions) {
            if (contribution.handler.afterCommit !== undefined) {
              yield* contribution.handler.afterCommit(organizationId);
            }
          }
          yield* afterDelete.run({ actor, organizationId });
        },
      );

      /** The platform administrator's read: an unknown id is `OrganizationNotFound`, a suspended one is found. */
      const requireExisting = (organizationId: string) =>
        orgs.findById(organizationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationErrors.OrganizationNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        );

      const suspend: OrganizationDirectoryShape["suspend"] = Effect.fnUntraced(
        function* (actor, input) {
          const { organizationId } = input;
          const reason = input.reason?.trim();
          const current = yield* requireExisting(organizationId);
          yield* HookPoint.aborted(OrganizationHooks.BeforeSuspendOrganization)(
            beforeSuspend.run({ actor, organizationId, reason }),
          );
          const suspended = Option.isSome(current.suspendedAt)
            ? current
            : yield* DateTime.now.pipe(
                Effect.flatMap((now) =>
                  orgs.setSuspended(platformGrant, organizationId, Option.some(now)),
                ),
                Effect.catchTag("OrganizationRecordNotFound", () =>
                  Effect.fail(new OrganizationErrors.OrganizationNotFound()),
                ),
              );
          yield* events.publish({
            _tag: "auth.admin.organizationSuspended",
            adminUserId: Users.UserId(actor.adminUserId),
            organizationId,
            reason: reason ?? null,
          });
          yield* afterSuspend.run({ actor, organizationId, reason });
          return suspended;
        },
      );

      const reinstate: OrganizationDirectoryShape["reinstate"] = Effect.fnUntraced(
        function* (actor, input) {
          const { organizationId } = input;
          yield* requireExisting(organizationId);
          yield* HookPoint.aborted(OrganizationHooks.BeforeReinstateOrganization)(
            beforeReinstate.run({ actor, organizationId }),
          );
          const reinstated = yield* orgs
            .setSuspended(platformGrant, organizationId, Option.none())
            .pipe(
              Effect.catchTag("OrganizationRecordNotFound", () =>
                Effect.fail(new OrganizationErrors.OrganizationNotFound()),
              ),
            );
          yield* events.publish({
            _tag: "auth.admin.organizationUnsuspended",
            adminUserId: Users.UserId(actor.adminUserId),
            organizationId,
          });
          yield* afterReinstate.run({ actor, organizationId });
          return reinstated;
        },
      );

      return OrganizationDirectory.of({
        find,
        findActive,
        requireActive,
        isSlugAvailable,
        listForUser,
        listPage,
        create,
        update,
        delete: remove,
        suspend,
        reinstate,
      });
    }),
  );
}
