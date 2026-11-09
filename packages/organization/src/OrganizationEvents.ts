// @awthaq/organization — OrganizationEvents: the events this plugin publishes (ADR-EA-049).
//
// Defined here, in the plugin's own package, declared on the `Organization` class's `events` and published
// with `events.emit(definition, input)` by its system modules and its authorization primitive
// (`internal/access.ts`). Core composes them (`Auth.make`), records each in the audit log with its actor,
// attempt lane and declared personal data (`meta.pii`), and `runPluginContractTests` checks each definition.
// `auth.admin.organization{Suspended, Unsuspended}` keep their tags: the platform tier's suspension is
// published by `OrganizationDirectory`. The module imports nothing of the plugin, so any of its modules can
// publish through it without a cycle.
import { EventDefinition } from "@awthaq/core";
import * as Schema from "effect/Schema";

const RoleNames = Schema.Array(Schema.String);

/**
 * EP-003 (ADR-EA-018): published by `@awthaq/admin`'s `AdminTenants.suspendOrganization`,
 * after the organization is marked suspended. `reason` is the operator's note, `null`
 * when none was given; operators write free text there, so it is declared `pii`.
 */
export const AdminOrganizationSuspendedEvent = EventDefinition.define(
  "auth.admin.organizationSuspended",
  {
    adminUserId: EventDefinition.UserId,
    organizationId: Schema.String,
    reason: Schema.NullOr(Schema.String),
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: ["reason"],
  },
);
export type AdminOrganizationSuspendedEvent = typeof AdminOrganizationSuspendedEvent.Type;

/** EP-003: published by `AdminTenants.unsuspendOrganization`, after the suspension is lifted. */
export const AdminOrganizationUnsuspendedEvent = EventDefinition.define(
  "auth.admin.organizationUnsuspended",
  {
    adminUserId: EventDefinition.UserId,
    organizationId: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type AdminOrganizationUnsuspendedEvent = typeof AdminOrganizationUnsuspendedEvent.Type;

/** Published by `@awthaq/organization`'s `create`. */
export const OrganizationCreatedEvent = EventDefinition.define(
  "auth.organization.created",
  {
    organizationId: Schema.String,
    creatorUserId: EventDefinition.UserId,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationCreatedEvent = typeof OrganizationCreatedEvent.Type;

/** Published by `@awthaq/organization`'s `update`. */
export const OrganizationUpdatedEvent = EventDefinition.define(
  "auth.organization.updated",
  {
    organizationId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationUpdatedEvent = typeof OrganizationUpdatedEvent.Type;

/** Published by `@awthaq/organization`'s `delete`. */
export const OrganizationDeletedEvent = EventDefinition.define(
  "auth.organization.deleted",
  {
    organizationId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationDeletedEvent = typeof OrganizationDeletedEvent.Type;

/** Published by `@awthaq/organization`'s `create` (the creator's own membership) and `addMember`. */
export const OrganizationMemberAddedEvent = EventDefinition.define(
  "auth.organization.memberAdded",
  {
    organizationId: Schema.String,
    userId: EventDefinition.UserId,
    role: RoleNames,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationMemberAddedEvent = typeof OrganizationMemberAddedEvent.Type;

/** Published by `@awthaq/organization`'s `removeMember`/`leave`. */
export const OrganizationMemberRemovedEvent = EventDefinition.define(
  "auth.organization.memberRemoved",
  {
    organizationId: Schema.String,
    userId: EventDefinition.UserId,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationMemberRemovedEvent = typeof OrganizationMemberRemovedEvent.Type;

/** Published by `@awthaq/organization`'s `updateMemberRole`. */
export const OrganizationMemberRoleUpdatedEvent = EventDefinition.define(
  "auth.organization.memberRoleUpdated",
  {
    organizationId: Schema.String,
    userId: EventDefinition.UserId,
    role: RoleNames,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationMemberRoleUpdatedEvent = typeof OrganizationMemberRoleUpdatedEvent.Type;

/**
 * Published by `@awthaq/organization`'s `invite`. ESA-005: identifiers only — the
 * invitee's email is *not* on the bus or in the audit row; a subscriber that needs
 * it resolves `invitationId` through the invitation record store, which the
 * erasure cascade owns.
 */
export const OrganizationInvitationCreatedEvent = EventDefinition.define(
  "auth.organization.invitationCreated",
  {
    invitationId: Schema.String,
    organizationId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationInvitationCreatedEvent = typeof OrganizationInvitationCreatedEvent.Type;

/** Published by `@awthaq/organization`'s `accept`. */
export const OrganizationInvitationAcceptedEvent = EventDefinition.define(
  "auth.organization.invitationAccepted",
  {
    invitationId: Schema.String,
    organizationId: Schema.String,
    userId: EventDefinition.UserId,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationInvitationAcceptedEvent = typeof OrganizationInvitationAcceptedEvent.Type;

/** Published by `@awthaq/organization`'s `reject`. */
export const OrganizationInvitationRejectedEvent = EventDefinition.define(
  "auth.organization.invitationRejected",
  {
    invitationId: Schema.String,
    organizationId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationInvitationRejectedEvent = typeof OrganizationInvitationRejectedEvent.Type;

/** Published by `@awthaq/organization`'s `cancel`. */
export const OrganizationInvitationCanceledEvent = EventDefinition.define(
  "auth.organization.invitationCanceled",
  {
    invitationId: Schema.String,
    organizationId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationInvitationCanceledEvent = typeof OrganizationInvitationCanceledEvent.Type;

/**
 * Published by `@awthaq/organization`'s invitation module when a pending invitation is found past its expiry
 * (an acceptance attempt after `expiresAt`); the invitation becomes `expired`. Identifiers only.
 */
export const OrganizationInvitationExpiredEvent = EventDefinition.define(
  "auth.organization.invitationExpired",
  {
    invitationId: Schema.String,
    organizationId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationInvitationExpiredEvent = typeof OrganizationInvitationExpiredEvent.Type;

/** Published by `@awthaq/organization`'s `createRole`. */
export const OrganizationRoleCreatedEvent = EventDefinition.define(
  "auth.organization.roleCreated",
  {
    organizationId: Schema.String,
    role: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationRoleCreatedEvent = typeof OrganizationRoleCreatedEvent.Type;

/** Published by `@awthaq/organization`'s `updateRole`. */
export const OrganizationRoleUpdatedEvent = EventDefinition.define(
  "auth.organization.roleUpdated",
  {
    organizationId: Schema.String,
    role: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationRoleUpdatedEvent = typeof OrganizationRoleUpdatedEvent.Type;

/** Published by `@awthaq/organization`'s `deleteRole`. */
export const OrganizationRoleDeletedEvent = EventDefinition.define(
  "auth.organization.roleDeleted",
  {
    organizationId: Schema.String,
    role: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationRoleDeletedEvent = typeof OrganizationRoleDeletedEvent.Type;

/**
 * `@awthaq/organization`'s per-organization OIDC/OAuth2 connection store, after each SUCCESSFUL mutation
 * (identifiers only; for an update the NAMES of the fields changed, never their values). `actorUserId` is the
 * user who acted when the actor names one (a member, a platform administrator); a directory or application
 * actor leaves it absent, so the audit row names no user.
 */
export const OrganizationConnectionCreatedEvent = EventDefinition.define(
  "auth.organization.connectionCreated",
  {
    organizationId: Schema.String,
    connectionId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationConnectionCreatedEvent = typeof OrganizationConnectionCreatedEvent.Type;

export const OrganizationConnectionUpdatedEvent = EventDefinition.define(
  "auth.organization.connectionUpdated",
  {
    organizationId: Schema.String,
    connectionId: Schema.String,
    fields: Schema.Array(Schema.String),
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationConnectionUpdatedEvent = typeof OrganizationConnectionUpdatedEvent.Type;

export const OrganizationConnectionDeletedEvent = EventDefinition.define(
  "auth.organization.connectionDeleted",
  {
    organizationId: Schema.String,
    connectionId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationConnectionDeletedEvent = typeof OrganizationConnectionDeletedEvent.Type;

/** Published by `@awthaq/organization`'s `createTeam`. */
export const OrganizationTeamCreatedEvent = EventDefinition.define(
  "auth.organization.teamCreated",
  {
    organizationId: Schema.String,
    teamId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationTeamCreatedEvent = typeof OrganizationTeamCreatedEvent.Type;

/** Published by `@awthaq/organization`'s `updateTeam`. */
export const OrganizationTeamUpdatedEvent = EventDefinition.define(
  "auth.organization.teamUpdated",
  {
    organizationId: Schema.String,
    teamId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationTeamUpdatedEvent = typeof OrganizationTeamUpdatedEvent.Type;

/** OHS-001: published by `@awthaq/organization`'s `moveTeam`; `parentId` is `null` when the team became a root. */
export const OrganizationTeamMovedEvent = EventDefinition.define(
  "auth.organization.teamMoved",
  {
    organizationId: Schema.String,
    teamId: Schema.String,
    parentId: Schema.NullOr(Schema.String),
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationTeamMovedEvent = typeof OrganizationTeamMovedEvent.Type;

/** Published by `@awthaq/organization`'s `removeTeam`. */
export const OrganizationTeamDeletedEvent = EventDefinition.define(
  "auth.organization.teamDeleted",
  {
    organizationId: Schema.String,
    teamId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationTeamDeletedEvent = typeof OrganizationTeamDeletedEvent.Type;

/** Published by `@awthaq/organization`'s `addTeamMember` (and `acceptInvitation` for a team-targeted invitation). */
export const OrganizationTeamMemberAddedEvent = EventDefinition.define(
  "auth.organization.teamMemberAdded",
  {
    organizationId: Schema.String,
    teamId: Schema.String,
    userId: EventDefinition.UserId,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationTeamMemberAddedEvent = typeof OrganizationTeamMemberAddedEvent.Type;

/** OHS-004: published by `@awthaq/organization`'s `updateTeamMemberRole`. */
export const OrganizationTeamMemberRoleUpdatedEvent = EventDefinition.define(
  "auth.organization.teamMemberRoleUpdated",
  {
    organizationId: Schema.String,
    teamId: Schema.String,
    userId: EventDefinition.UserId,
    role: RoleNames,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationTeamMemberRoleUpdatedEvent =
  typeof OrganizationTeamMemberRoleUpdatedEvent.Type;

/** Published by `@awthaq/organization`'s `removeTeamMember`. */
export const OrganizationTeamMemberRemovedEvent = EventDefinition.define(
  "auth.organization.teamMemberRemoved",
  {
    organizationId: Schema.String,
    teamId: Schema.String,
    userId: EventDefinition.UserId,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationTeamMemberRemovedEvent = typeof OrganizationTeamMemberRemovedEvent.Type;

/**
 * Published by `@awthaq/organization` whenever its own `PermissionEngine`
 * gating denies an operation (PERS-005) — the plugin authorizes without a
 * qadi round trip, so without this its denials would leave no durable record.
 * `reason` says why: the caller is not a member (`notMember`, answered to the
 * caller as a 404) or is a member without the statement (`missingStatement`).
 */
export const OrganizationPermissionDeniedEvent = EventDefinition.define(
  "auth.organization.permissionDenied",
  {
    organizationId: Schema.String,
    userId: EventDefinition.UserId,
    resource: Schema.String,
    action: Schema.String,
    reason: Schema.Literals(["notMember", "missingStatement"]),
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
    attempt: true,
  },
);
export type OrganizationPermissionDeniedEvent = typeof OrganizationPermissionDeniedEvent.Type;

/** Every event this plugin publishes; the plugin class declares it as `events`. */
export const events = [
  AdminOrganizationSuspendedEvent,
  AdminOrganizationUnsuspendedEvent,
  OrganizationConnectionCreatedEvent,
  OrganizationConnectionUpdatedEvent,
  OrganizationConnectionDeletedEvent,
  OrganizationCreatedEvent,
  OrganizationUpdatedEvent,
  OrganizationDeletedEvent,
  OrganizationMemberAddedEvent,
  OrganizationMemberRemovedEvent,
  OrganizationMemberRoleUpdatedEvent,
  OrganizationInvitationCreatedEvent,
  OrganizationInvitationAcceptedEvent,
  OrganizationInvitationRejectedEvent,
  OrganizationInvitationCanceledEvent,
  OrganizationInvitationExpiredEvent,
  OrganizationRoleCreatedEvent,
  OrganizationRoleUpdatedEvent,
  OrganizationRoleDeletedEvent,
  OrganizationTeamCreatedEvent,
  OrganizationTeamUpdatedEvent,
  OrganizationTeamMovedEvent,
  OrganizationTeamDeletedEvent,
  OrganizationTeamMemberAddedEvent,
  OrganizationTeamMemberRoleUpdatedEvent,
  OrganizationTeamMemberRemovedEvent,
  OrganizationPermissionDeniedEvent,
];
