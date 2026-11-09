// @awthaq/roles — RolesEvents: the events this plugin publishes (ADR-EA-049).
//
// Defined here, in the plugin's own package, declared on the `Roles` class's `events` and published with
// `events.emit(definition, input)`. Core composes them (`Auth.make`), records each in the audit log with its
// actor, and `runPluginContractTests` checks each definition. The module imports nothing of the plugin, so any
// of its modules can publish through it without a cycle.
import { EventDefinition } from "@awthaq/core";
import * as Schema from "effect/Schema";

/**
 * Published by `@awthaq/roles`' `assign`/`revoke` on a *real* change of a
 * user's global role assignments (RRM-005): a re-assign or a revoke of a role
 * the user never held publishes nothing. `userId` is the user whose roles
 * changed; `actorUserId` the operator who changed them, when the caller said —
 * `Roles` is a trusted primitive, so an application-driven change has none.
 */
export const RolesAssignedEvent = EventDefinition.define(
  "auth.roles.assigned",
  {
    userId: EventDefinition.UserId,
    roleName: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    // The actor is who *changed* the roles, not whose roles changed.
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type RolesAssignedEvent = typeof RolesAssignedEvent.Type;

/** Published by `@awthaq/roles`' `revoke` (see `RolesAssignedEvent`). */
export const RolesRevokedEvent = EventDefinition.define(
  "auth.roles.revoked",
  {
    userId: EventDefinition.UserId,
    roleName: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    // The actor is who *changed* the roles, not whose roles changed.
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type RolesRevokedEvent = typeof RolesRevokedEvent.Type;

/** Every event this plugin publishes; the plugin class declares it as `events`. */
export const events = [RolesAssignedEvent, RolesRevokedEvent];
