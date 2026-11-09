// @awthaq/scim — ScimEvents: the events this plugin publishes (ADR-EA-049).
//
// Defined here, in the plugin's own package, declared on the `Scim` class's `events` and published with
// `events.emit(definition, input)`. Core composes them (`Auth.make`), records each in the audit log with its
// actor (none: a directory acts, CWM-002), and `runPluginContractTests` checks each definition. The module
// imports nothing of the plugin, so any of its modules can publish through it without a cycle.
import { EventDefinition } from "@awthaq/core";
import * as Schema from "effect/Schema";

/**
 * CWM-002 (ADR-EA-023): published by `@awthaq/scim` when a directory connection provisions a
 * user (a repeat `POST` that converges on an existing one publishes nothing). `connectionId`
 * names the SCIM connection, `organizationId` its organization.
 */
export const ScimUserProvisionedEvent = EventDefinition.define(
  "auth.scim.userProvisioned",
  {
    connectionId: Schema.String,
    organizationId: Schema.String,
    userId: EventDefinition.UserId,
  },
  {
    // CWM-002: a directory acts, not a user — the connection id rides in the payload.
    actor: EventDefinition.Actor.none,
    pii: [],
  },
);
export type ScimUserProvisionedEvent = typeof ScimUserProvisionedEvent.Type;

/** CWM-002: published after a SCIM `active: false` (or `DELETE`, by default) suspended the user and revoked every session. */
export const ScimUserDeactivatedEvent = EventDefinition.define(
  "auth.scim.userDeactivated",
  {
    connectionId: Schema.String,
    organizationId: Schema.String,
    userId: EventDefinition.UserId,
  },
  {
    // CWM-002: a directory acts, not a user — the connection id rides in the payload.
    actor: EventDefinition.Actor.none,
    pii: [],
  },
);
export type ScimUserDeactivatedEvent = typeof ScimUserDeactivatedEvent.Type;

/** CWM-002: published after a SCIM `active: true` lifted a suspension that same connection made. */
export const ScimUserReactivatedEvent = EventDefinition.define(
  "auth.scim.userReactivated",
  {
    connectionId: Schema.String,
    organizationId: Schema.String,
    userId: EventDefinition.UserId,
  },
  {
    // CWM-002: a directory acts, not a user — the connection id rides in the payload.
    actor: EventDefinition.Actor.none,
    pii: [],
  },
);
export type ScimUserReactivatedEvent = typeof ScimUserReactivatedEvent.Type;

/** CWM-002: published after a SCIM `DELETE` configured to erase removed the user. */
export const ScimUserDeletedEvent = EventDefinition.define(
  "auth.scim.userDeleted",
  {
    connectionId: Schema.String,
    organizationId: Schema.String,
    userId: EventDefinition.UserId,
  },
  {
    // CWM-002: a directory acts, not a user — the connection id rides in the payload.
    actor: EventDefinition.Actor.none,
    pii: [],
  },
);
export type ScimUserDeletedEvent = typeof ScimUserDeletedEvent.Type;

/** CWM-002: published when a SCIM connection creates, updates or deletes a group (an organization team). */
export const ScimGroupChangedEvent = EventDefinition.define(
  "auth.scim.groupChanged",
  {
    connectionId: Schema.String,
    organizationId: Schema.String,
    teamId: Schema.String,
    change: Schema.Literals(["created", "updated", "deleted"]),
  },
  {
    // CWM-002: a directory acts, not a user — the connection id rides in the payload.
    actor: EventDefinition.Actor.none,
    pii: [],
  },
);
export type ScimGroupChangedEvent = typeof ScimGroupChangedEvent.Type;

/** Every event this plugin publishes; the plugin class declares it as `events`. */
export const events = [
  ScimUserProvisionedEvent,
  ScimUserDeactivatedEvent,
  ScimUserReactivatedEvent,
  ScimUserDeletedEvent,
  ScimGroupChangedEvent,
];
