// @awthaq/webhooks — WebhookEvents: the events this plugin publishes (ADR-EA-049).
//
// Defined here, in the plugin's own package, declared on the `Webhooks` class's `events` and published with
// `events.emit(definition, input)`. Core composes them (`Auth.make`), records each in the audit log with its
// actor, and `runPluginContractTests` checks each definition. Webhooks is composed whenever it serves, so an
// endpoint filter naming `auth.webhooks.*` always resolves against the composed registry. The module imports
// nothing of the plugin, so any of its modules can publish through it without a cycle.
import { EventDefinition } from "@awthaq/core";
import * as Schema from "effect/Schema";

/**
 * Published by `@awthaq/webhooks`' administrative operations after each SUCCESSFUL mutation
 * (identifiers only: the administrator, the endpoint, and for an update the names of the fields
 * changed, never their values, so a URL or a description never enters the audit trail).
 */
export const WebhookEndpointCreatedEvent = EventDefinition.define(
  "auth.webhooks.endpointCreated",
  {
    adminUserId: EventDefinition.UserId,
    endpointId: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type WebhookEndpointCreatedEvent = typeof WebhookEndpointCreatedEvent.Type;

export const WebhookEndpointUpdatedEvent = EventDefinition.define(
  "auth.webhooks.endpointUpdated",
  {
    adminUserId: EventDefinition.UserId,
    endpointId: Schema.String,
    fields: Schema.Array(Schema.String),
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type WebhookEndpointUpdatedEvent = typeof WebhookEndpointUpdatedEvent.Type;

export const WebhookSecretRotatedEvent = EventDefinition.define(
  "auth.webhooks.secretRotated",
  {
    adminUserId: EventDefinition.UserId,
    endpointId: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type WebhookSecretRotatedEvent = typeof WebhookSecretRotatedEvent.Type;

export const WebhookEndpointDeletedEvent = EventDefinition.define(
  "auth.webhooks.endpointDeleted",
  {
    adminUserId: EventDefinition.UserId,
    endpointId: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type WebhookEndpointDeletedEvent = typeof WebhookEndpointDeletedEvent.Type;

/** A test ping was queued for an endpoint (`@awthaq/webhooks`): the administrator caused an outbound call. */
export const WebhookTestQueuedEvent = EventDefinition.define(
  "auth.webhooks.testQueued",
  {
    adminUserId: EventDefinition.UserId,
    endpointId: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type WebhookTestQueuedEvent = typeof WebhookTestQueuedEvent.Type;

/** Every event this plugin publishes; the plugin class declares it as `events`. */
export const events = [
  WebhookEndpointCreatedEvent,
  WebhookEndpointUpdatedEvent,
  WebhookSecretRotatedEvent,
  WebhookEndpointDeletedEvent,
  WebhookTestQueuedEvent,
];
