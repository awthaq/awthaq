// @awthaq/qadi — UserClaimsEvents: the events the `UserClaims` plugin publishes (ADR-EA-049).
//
// Defined here, in the plugin's own package, declared on the `UserClaims` class's `events` and published with
// `events.emit(definition, input)`. Core composes them (`Auth.make`), records each in the audit log with its
// actor, and `runPluginContractTests` checks each definition. `auth.authz.denied`, which qadi's decision
// logging publishes without a plugin of its own, stays in core. The module imports nothing of the package, so
// any of its modules can publish through it without a cycle.
import { EventDefinition } from "@awthaq/core";
import * as Schema from "effect/Schema";

/**
 * FAMS-004: published by `@awthaq/qadi`'s `UserClaims` on a real change. `keys` names the
 * claim keys that changed — never their values, which may be sensitive and must not enter the
 * audit trail; `actorUserId` is who made the change, when known.
 */
export const UserClaimsUpdatedEvent = EventDefinition.define(
  "auth.user.claimsUpdated",
  {
    userId: EventDefinition.UserId,
    keys: Schema.Array(Schema.String),
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    // The actor is who *changed* the claims, not whose claims changed.
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type UserClaimsUpdatedEvent = typeof UserClaimsUpdatedEvent.Type;

/** Every event this plugin publishes; the plugin class declares it as `events`. */
export const events = [UserClaimsUpdatedEvent];
