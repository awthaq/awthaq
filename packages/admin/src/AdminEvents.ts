// @awthaq/admin — AdminEvents: the events this package's plugins publish (ADR-EA-049).
//
// Defined here, in the plugin's own package, and published with `events.emit(definition, input)`. Two plugin
// classes publish them, and each can be composed without the other, so each declares its own list: `Admin`
// declares `events`, `AdminAccounts` declares `accountsEvents`. Core composes them (`Auth.make`), records each
// in the audit log with its actor and declared personal data (`meta.pii`), and `runPluginContractTests`
// checks each definition. `auth.admin.{impersonationDenied, actionDenied, seeded, seedRefused}` stay in core:
// other packages publish them too. The module imports nothing of the package, so any of its modules can
// publish through it without a cycle.
import { EventDefinition } from "@awthaq/core";
import * as Schema from "effect/Schema";

/**
 * Published by `@awthaq/admin`'s `impersonate`, on success (BEH-EA-218).
 * `reason` is the BEH-EA-218 justification — free text an admin typed, so it
 * is declared personal data (`pii`) and scrubbed when the target/admin is erased.
 */
export const AdminImpersonationStartedEvent = EventDefinition.define(
  "auth.admin.impersonationStarted",
  {
    adminUserId: EventDefinition.UserId,
    targetUserId: EventDefinition.UserId,
    reason: Schema.String,
    sessionId: EventDefinition.SessionId,
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: ["reason"],
  },
);
export type AdminImpersonationStartedEvent = typeof AdminImpersonationStartedEvent.Type;

/** Published by `@awthaq/admin`'s `stopImpersonating`/`forceStop` (BEH-EA-218). IDS-006: names both parties, so a SIEM need not join `ImpersonationRecords`. */
export const AdminImpersonationStoppedEvent = EventDefinition.define(
  "auth.admin.impersonationStopped",
  {
    sessionId: EventDefinition.SessionId,
    adminUserId: EventDefinition.UserId,
    targetUserId: EventDefinition.UserId,
    endedBy: Schema.Literals(["self", "forcedByAdmin", "expired"]),
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type AdminImpersonationStoppedEvent = typeof AdminImpersonationStoppedEvent.Type;

/** BAM-005: published by `@awthaq/admin`'s `updateUser`, after the profile change is persisted. */
export const AdminUserUpdatedEvent = EventDefinition.define(
  "auth.admin.userUpdated",
  {
    adminUserId: EventDefinition.UserId,
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type AdminUserUpdatedEvent = typeof AdminUserUpdatedEvent.Type;

/**
 * BAM-005: published by `@awthaq/admin`'s `revokeUserSession`/`revokeUserSessions`.
 * `sessionId` is the one revoked session, or `null` when every non-impersonation
 * session of `userId` was revoked in one call.
 */
export const AdminSessionRevokedEvent = EventDefinition.define(
  "auth.admin.sessionRevoked",
  {
    adminUserId: EventDefinition.UserId,
    userId: EventDefinition.UserId,
    sessionId: Schema.NullOr(EventDefinition.SessionId),
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type AdminSessionRevokedEvent = typeof AdminSessionRevokedEvent.Type;

/**
 * BAM-005/SCP-001: published by `@awthaq/admin`'s `banUser`, after `Users.setStatus("suspended")`
 * and `Sessions.revokeAll(userId, "suspended")` both completed. `reason`/`until` are the
 * operator's note and the optional expiry (ISO instant), `null` when not given. The note is
 * free text about the banned person, so it is declared `pii`: erasure blanks it and a webhook
 * body omits it.
 */
export const AdminUserBannedEvent = EventDefinition.define(
  "auth.admin.userBanned",
  {
    adminUserId: EventDefinition.UserId,
    userId: EventDefinition.UserId,
    reason: Schema.NullOr(Schema.String),
    until: Schema.NullOr(Schema.String),
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: ["reason"],
  },
);
export type AdminUserBannedEvent = typeof AdminUserBannedEvent.Type;

/** BAM-005: published by `@awthaq/admin`'s `unbanUser`, after `Users.setStatus("active")`. */
export const AdminUserUnbannedEvent = EventDefinition.define(
  "auth.admin.userUnbanned",
  {
    adminUserId: EventDefinition.UserId,
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type AdminUserUnbannedEvent = typeof AdminUserUnbannedEvent.Type;

/**
 * BAM-005: published by `@awthaq/admin`'s `AdminAccounts.deleteUser` after the erasure cascade
 * committed. The erasure itself is announced by `auth.user.deleted` (`deletedBy: "admin"`); this
 * one names *which administrator* did it.
 */
export const AdminUserDeletedEvent = EventDefinition.define(
  "auth.admin.userDeleted",
  {
    adminUserId: EventDefinition.UserId,
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type AdminUserDeletedEvent = typeof AdminUserDeletedEvent.Type;

/**
 * BAM-005/BAM-009: published by `AdminAccounts.setUserEmail` once the confirmation mail to the new
 * address went out. The address is not changed yet: its owner completes the change from the mail.
 * No address in the payload (ADR-EA-029).
 */
export const AdminUserEmailChangeRequestedEvent = EventDefinition.define(
  "auth.admin.userEmailChangeRequested",
  {
    adminUserId: EventDefinition.UserId,
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type AdminUserEmailChangeRequestedEvent = typeof AdminUserEmailChangeRequestedEvent.Type;

/**
 * BAM-005: published by `AdminAccounts.setUserPassword` after the credential hash was replaced and
 * every session of the user was revoked (reason `admin`).
 */
export const AdminUserPasswordSetEvent = EventDefinition.define(
  "auth.admin.userPasswordSet",
  {
    adminUserId: EventDefinition.UserId,
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type AdminUserPasswordSetEvent = typeof AdminUserPasswordSetEvent.Type;

/** The events the `Admin` plugin publishes; its class declares them as `events`. */
export const events = [
  AdminImpersonationStartedEvent,
  AdminImpersonationStoppedEvent,
  AdminUserUpdatedEvent,
  AdminUserBannedEvent,
  AdminUserUnbannedEvent,
  AdminSessionRevokedEvent,
];

/** The events the `AdminAccounts` plugin publishes; its class declares them as `events`. */
export const accountsEvents = [
  AdminUserDeletedEvent,
  AdminUserEmailChangeRequestedEvent,
  AdminUserPasswordSetEvent,
];
