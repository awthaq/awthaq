// @awthaq/api-key — ApiKeyEvents: the events this plugin publishes (ADR-EA-049).
//
// Defined here, in the plugin's own package, declared on the `ApiKey` class's `events` and published with
// `events.emit(definition, input)`. Core composes them (`Auth.make`), records each in the audit log with its
// actor, and `runPluginContractTests` checks each definition. The module imports nothing of the plugin, so any
// of its modules can publish through it without a cycle.
import { EventDefinition } from "@awthaq/core";
import * as Schema from "effect/Schema";

/**
 * OCM-002/OCM-005 (`@awthaq/api-key`): the lifecycle of a long-lived API key and of a
 * `client_credentials` client. `userId` is the owner who acted; `keyId`/`clientId`
 * are the public ids (never a secret or a hash). `rotated` names the predecessor
 * (`keyId`) and its successor.
 */
export const ApiKeyCreatedEvent = EventDefinition.define(
  "auth.apiKey.created",
  {
    userId: EventDefinition.UserId,
    keyId: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type ApiKeyCreatedEvent = typeof ApiKeyCreatedEvent.Type;

export const ApiKeyRevokedEvent = EventDefinition.define(
  "auth.apiKey.revoked",
  {
    userId: EventDefinition.UserId,
    keyId: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type ApiKeyRevokedEvent = typeof ApiKeyRevokedEvent.Type;

export const ApiKeyRotatedEvent = EventDefinition.define(
  "auth.apiKey.rotated",
  {
    userId: EventDefinition.UserId,
    keyId: Schema.String,
    successorKeyId: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type ApiKeyRotatedEvent = typeof ApiKeyRotatedEvent.Type;

export const ApiKeyClientRegisteredEvent = EventDefinition.define(
  "auth.apiKey.clientRegistered",
  {
    userId: EventDefinition.UserId,
    clientId: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type ApiKeyClientRegisteredEvent = typeof ApiKeyClientRegisteredEvent.Type;

export const ApiKeyClientRevokedEvent = EventDefinition.define(
  "auth.apiKey.clientRevoked",
  {
    userId: EventDefinition.UserId,
    clientId: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type ApiKeyClientRevokedEvent = typeof ApiKeyClientRevokedEvent.Type;

export const ApiKeyClientSecretRotatedEvent = EventDefinition.define(
  "auth.apiKey.clientSecretRotated",
  {
    userId: EventDefinition.UserId,
    clientId: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type ApiKeyClientSecretRotatedEvent = typeof ApiKeyClientSecretRotatedEvent.Type;

/** Every event this plugin publishes; the plugin class declares it as `events`. */
export const events = [
  ApiKeyCreatedEvent,
  ApiKeyRevokedEvent,
  ApiKeyRotatedEvent,
  ApiKeyClientRegisteredEvent,
  ApiKeyClientRevokedEvent,
  ApiKeyClientSecretRotatedEvent,
];
