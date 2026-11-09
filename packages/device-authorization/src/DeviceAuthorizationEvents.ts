// @awthaq/device-authorization — DeviceAuthorizationEvents: the events this plugin publishes (ADR-EA-049).
//
// Defined here, in the plugin's own package, declared on the `DeviceAuthorization` class's `events` and
// published with `events.emit(definition, input)`. Core composes them (`Auth.make`), records each in the audit
// log with its actor, and `runPluginContractTests` checks each definition. The module imports nothing of the
// plugin, so any of its modules can publish through it without a cycle.
import { EventDefinition } from "@awthaq/core";
import * as Schema from "effect/Schema";

/**
 * BEH-EA-306 (`@awthaq/device-authorization`): a person's decision on a device grant. `userId` is
 * the approver, `clientId` the registered client that asked. The user code, the device code, their
 * hashes and the scope are never carried: identifiers only (ADR-EA-029). The session the approved
 * grant later becomes is announced by the ordinary `auth.session.issued` / `auth.user.signedIn`
 * (strategy `deviceAuthorization`).
 */
export const DeviceAuthorizationApprovedEvent = EventDefinition.define(
  "auth.deviceAuthorization.approved",
  { userId: EventDefinition.UserId, clientId: Schema.String },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type DeviceAuthorizationApprovedEvent = typeof DeviceAuthorizationApprovedEvent.Type;

export const DeviceAuthorizationDeniedEvent = EventDefinition.define(
  "auth.deviceAuthorization.denied",
  { userId: EventDefinition.UserId, clientId: Schema.String },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
    attempt: true,
  },
);
export type DeviceAuthorizationDeniedEvent = typeof DeviceAuthorizationDeniedEvent.Type;

/** Every event this plugin publishes; the plugin class declares it as `events`. */
export const events = [DeviceAuthorizationApprovedEvent, DeviceAuthorizationDeniedEvent];
