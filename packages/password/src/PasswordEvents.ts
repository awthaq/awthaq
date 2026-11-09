// @awthaq/password — PasswordEvents: the events this plugin publishes (ADR-EA-049).
//
// Defined here, in the plugin's own package, declared on the `Password` class's `events` and published with
// `events.emit(definition, input)`. Core composes them (`Auth.make`), records each in the audit log with its
// actor, and `runPluginContractTests` checks each definition. `auth.password.changed` stays in core: the
// admin plugin publishes it too. The module imports nothing of the plugin, so any of its modules can publish
// through it without a cycle.
import { EventDefinition } from "@awthaq/core";

/** ARF-006: published by `@awthaq/password`'s `verifyEmail` after the flag flips — the hook for owner notification / SIEM export. */
export const UserEmailVerifiedEvent = EventDefinition.define(
  "auth.user.emailVerified",
  {
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type UserEmailVerifiedEvent = typeof UserEmailVerifiedEvent.Type;

/**
 * BAM-009/BAM-005: published by `@awthaq/password`'s change-email confirmation after the address
 * was replaced and marked verified. No address, old or new (ADR-EA-029): identifiers only.
 */
export const UserEmailChangedEvent = EventDefinition.define(
  "auth.user.emailChanged",
  {
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type UserEmailChangedEvent = typeof UserEmailChangedEvent.Type;

/**
 * ARF-006: published by `@awthaq/password`'s `requestReset` when a real account
 * exists — the earliest takeover signal, the hook for out-of-band owner
 * notification. Published from inside the detached mail branch, so it never
 * reintroduces the enumeration side channel (the response path is unchanged).
 */
export const PasswordResetRequestedEvent = EventDefinition.define(
  "auth.password.resetRequested",
  {
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type PasswordResetRequestedEvent = typeof PasswordResetRequestedEvent.Type;

/** ALF-004: published by `@awthaq/password`'s `confirmReset`, once the transaction (consume + rehash + revoke) has committed. */
export const PasswordResetCompletedEvent = EventDefinition.define(
  "auth.password.resetCompleted",
  {
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type PasswordResetCompletedEvent = typeof PasswordResetCompletedEvent.Type;

/** Every event this plugin publishes; the plugin class declares it as `events`. */
export const events = [
  UserEmailVerifiedEvent,
  UserEmailChangedEvent,
  PasswordResetRequestedEvent,
  PasswordResetCompletedEvent,
];
