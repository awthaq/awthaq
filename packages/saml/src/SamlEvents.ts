// @awthaq/saml — SamlEvents: the events this plugin publishes (ADR-EA-049).
//
// Defined here, in the plugin's own package, declared on the `Saml` class's `events` and published with
// `events.emit(definition, input)` by its `SamlAdmin` and `SamlSlo` modules. Core composes them (`Auth.make`),
// records each in the audit log with its actor, and `runPluginContractTests` checks each definition.
// `auth.admin.actionDenied`, which saml also publishes, stays in core. The module imports nothing of the
// plugin, so its modules publish through it without a cycle.
import { EventDefinition } from "@awthaq/core";
import * as Schema from "effect/Schema";

/**
 * `@awthaq/saml`'s administrative operations, after each SUCCESSFUL mutation (identifiers only: the administrator, the
 * connection and its organization, and for an update the NAMES of the fields changed, never their values).
 */
export const SamlConnectionCreatedEvent = EventDefinition.define(
  "auth.saml.connectionCreated",
  {
    adminUserId: EventDefinition.UserId,
    connectionId: Schema.String,
    organizationId: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type SamlConnectionCreatedEvent = typeof SamlConnectionCreatedEvent.Type;

export const SamlConnectionUpdatedEvent = EventDefinition.define(
  "auth.saml.connectionUpdated",
  {
    adminUserId: EventDefinition.UserId,
    connectionId: Schema.String,
    organizationId: Schema.String,
    fields: Schema.Array(Schema.String),
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type SamlConnectionUpdatedEvent = typeof SamlConnectionUpdatedEvent.Type;

export const SamlConnectionDeletedEvent = EventDefinition.define(
  "auth.saml.connectionDeleted",
  {
    adminUserId: EventDefinition.UserId,
    connectionId: Schema.String,
    organizationId: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type SamlConnectionDeletedEvent = typeof SamlConnectionDeletedEvent.Type;

/** A new SP signing key was generated or imported for a connection (its private half is sealed at rest and never published). */
export const SamlSigningKeyRotatedEvent = EventDefinition.define(
  "auth.saml.signingKeyRotated",
  {
    adminUserId: EventDefinition.UserId,
    connectionId: Schema.String,
    organizationId: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type SamlSigningKeyRotatedEvent = typeof SamlSigningKeyRotatedEvent.Type;

/**
 * `@awthaq/saml`: a Single Logout message was refused (`strategy` is `saml:<organizationId>:<connectionId>` once the
 * connection is known, `saml` before). The reason is logged, never published or answered (no validation oracle).
 */
export const SamlLogoutRejectedEvent = EventDefinition.define(
  "auth.saml.logoutRejected",
  {
    strategy: Schema.String,
  },
  {
    // `@awthaq/saml`: a logout message that named no verified user.
    actor: EventDefinition.Actor.none,
    pii: [],
  },
);
export type SamlLogoutRejectedEvent = typeof SamlLogoutRejectedEvent.Type;

/** Every event this plugin publishes; the plugin class declares it as `events`. */
export const events = [
  SamlConnectionCreatedEvent,
  SamlConnectionUpdatedEvent,
  SamlConnectionDeletedEvent,
  SamlSigningKeyRotatedEvent,
  SamlLogoutRejectedEvent,
];
