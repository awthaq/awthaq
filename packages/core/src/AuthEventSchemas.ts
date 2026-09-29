// @awthaq/core — AuthEventSchemas
//
// spec/behaviors/13-events.md, BEH-EA-101: the closed registry of event types.
// A leaf module (it imports neither `AuthEvents` nor `AuditLog`), so both can
// depend on it at runtime without a cycle; `AuthEvents` re-exports all of it.
//
// ESA-007 (.issues/low): every event is an Effect `Schema` (a `TaggedStruct`)
// and its TypeScript type is derived from that schema, so the durable
// `AuditLog` can *decode* a stored payload back into a typed `AuthEvent`
// instead of reading it as `unknown`. The wire/storage version lives on the
// stored envelope (`EVENT_VERSION`), not in every publisher's call: a breaking
// payload change bumps it and adds an upcaster in `upcastPayload`, so old rows
// stay decodable (BEH-EA-101).
//
// GC-007: id fields are branded — `userId`/`adminUserId`/... as `UserId`,
// `sessionId` as `SessionId`. The brands are declared here with
// `Schema.brand` under the same brand names `Users.ts`/`Sessions.ts` use
// (`Brand.nominal<UserId>()`, `Brand.nominal<SessionId>()`), so the two are the
// same nominal type without this module importing either of them.
//
// PII posture (ESA-005, ADR-EA-029): payloads carry identifiers, never contact
// details or free text about a person. A subscriber that needs an email joins
// through the record store, which the erasure cascade owns. The two exceptions
// are declared in `PII_FIELDS` so erasure can scrub them: the impersonation
// justification text.

import type * as DateTime from "effect/DateTime";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const UserIdSchema = Schema.String.pipe(Schema.brand("UserId"));
const SessionIdSchema = Schema.String.pipe(Schema.brand("SessionId"));
const RoleNames = Schema.Array(Schema.String);

/** BEH-EA-059: published whenever `Verification.consume` fails — expired, unknown, or already-consumed alike (the same uniform-response reasoning as `TokenConsumed` itself). */
export const TokenReplayEvent = Schema.TaggedStruct("auth.token.replay", {
  identifier: Schema.String,
});
export type TokenReplayEvent = typeof TokenReplayEvent.Type;

/** Published by `@awthaq/password`'s `signUp` and `@awthaq/oauth`'s first-login creation. */
export const UserCreatedEvent = Schema.TaggedStruct("auth.user.created", { userId: UserIdSchema });
export type UserCreatedEvent = typeof UserCreatedEvent.Type;

/** Published by `@awthaq/password`/`oauth`/`passkey` once a sign-in has completed. */
export const UserSignedInEvent = Schema.TaggedStruct("auth.user.signedIn", {
  userId: UserIdSchema,
  strategy: Schema.String,
});
export type UserSignedInEvent = typeof UserSignedInEvent.Type;

/**
 * ALF-003/CSD-004: why a sign-in failed. The wire response's uniform-response
 * discipline (BEH-EA-116) hides which of these applied from the caller; the
 * audit channel deliberately keeps the distinction, since making
 * brute-force/credential-stuffing attempts visible to a defender requires it.
 */
export const SignInFailureReason = Schema.Literals([
  "invalidCredentials",
  "emailNotVerified",
  "assertionInvalid",
  "callbackRejected",
  // SCP-001: the credential was right but `Users.assertCanSignIn` refused (a suspended account).
  "suspended",
]);
export type SignInFailureReason = typeof SignInFailureReason.Type;

/**
 * ALF-003/CSD-004: published on a failed sign-in by every strategy. No
 * `userId` and no email: a nonexistent-account attempt has no `userId` to
 * carry, and a *present* one would itself leak account existence through the
 * event's own shape — the oracle the wire response's uniform response exists
 * to close, relocated to whoever is subscribed. What a stuffing detector needs
 * instead is a dimension to key velocity on: the source `clientIp`, and
 * `identifierDigest`, a keyed non-reversible digest of the *attempted*
 * identifier — computed identically for an existing and a nonexistent account,
 * so it is no oracle either.
 */
export const UserSignInFailedEvent = Schema.TaggedStruct("auth.user.signInFailed", {
  strategy: Schema.String,
  reason: SignInFailureReason,
  /** The address the attempt came from (not `ip`, which is the envelope's own request-context field). */
  clientIp: Schema.optionalKey(Schema.String),
  identifierDigest: Schema.optionalKey(Schema.String),
});
export type UserSignInFailedEvent = typeof UserSignInFailedEvent.Type;

/** ARF-006: published by `@awthaq/password`'s `verifyEmail` after the flag flips — the hook for owner notification / SIEM export. */
export const UserEmailVerifiedEvent = Schema.TaggedStruct("auth.user.emailVerified", {
  userId: UserIdSchema,
});
export type UserEmailVerifiedEvent = typeof UserEmailVerifiedEvent.Type;

/**
 * BAM-009/BAM-005: published by `@awthaq/password`'s change-email confirmation after the address
 * was replaced and marked verified. No address, old or new (ADR-EA-029): identifiers only.
 */
export const UserEmailChangedEvent = Schema.TaggedStruct("auth.user.emailChanged", {
  userId: UserIdSchema,
});
export type UserEmailChangedEvent = typeof UserEmailChangedEvent.Type;

/**
 * SCP-006: published once a user's deletion has committed (`@awthaq/server`'s
 * account deletion). Deliberately no email: the row is being erased (ESA-005),
 * and the audit rows that outlive it are pseudonymized, not deleted.
 */
export const UserDeletedEvent = Schema.TaggedStruct("auth.user.deleted", {
  userId: UserIdSchema,
  deletedBy: Schema.Literals(["self", "admin"]),
});
export type UserDeletedEvent = typeof UserDeletedEvent.Type;

/**
 * CSG-005: published each time a data-subject export (GDPR Art. 15/20) is produced, so the
 * audit trail records who exported whose data. Ids only — the document itself is never an
 * event payload. `requestedBy` is the account holder (`"self"`) or an administrator acting
 * for them (`"admin"`).
 */
export const UserDataExportedEvent = Schema.TaggedStruct("auth.user.dataExported", {
  userId: UserIdSchema,
  requestedBy: Schema.Literals(["self", "admin"]),
});
export type UserDataExportedEvent = typeof UserDataExportedEvent.Type;

/**
 * RRS-003: published by `Sessions.verify` the first time a tombstoned
 * (already-superseded) session token is presented again — refresh-token
 * reuse, the standard signal a token family has been compromised. Every
 * still-live row sharing `familyId` is revoked in the same call.
 */
export const SessionReuseEvent = Schema.TaggedStruct("auth.session.reuse", {
  sessionId: SessionIdSchema,
  familyId: Schema.String,
  userId: UserIdSchema,
});
export type SessionReuseEvent = typeof SessionReuseEvent.Type;

/**
 * ALF-004/ESA-006: published by `Sessions.issue` itself (both layers), so
 * every path that mints a session — password, OAuth, passkey, admin
 * impersonation, a legacy-session bridge, a `supersedes` rotation — emits
 * exactly one, with no plugin having to remember to.
 */
export const SessionIssuedEvent = Schema.TaggedStruct("auth.session.issued", {
  sessionId: SessionIdSchema,
  userId: UserIdSchema,
  /** RRS-003: the rotation family this session belongs to (its own id for a fresh family). */
  familyId: Schema.String,
  /** BEH-EA-209: present only for an impersonation session. */
  actingAs: Schema.optionalKey(Schema.Struct({ type: Schema.String, id: Schema.String })),
});
export type SessionIssuedEvent = typeof SessionIssuedEvent.Type;

/** RRS-008: published by `Sessions.verify` on the winning in-place secret rotation only (the concurrent loser reports `rotated: none` and publishes nothing), and by a grace-window recovery rotation (RRS-005). */
export const SessionRotatedEvent = Schema.TaggedStruct("auth.session.rotated", {
  sessionId: SessionIdSchema,
  familyId: Schema.String,
  userId: UserIdSchema,
  /** RRS-005: set when the rotation was triggered by the *previous* secret inside `SessionConfig.rotationGrace` — a client that missed the last delivery recovering, worth a detector's attention if frequent. */
  viaGrace: Schema.optional(Schema.Boolean),
});
export type SessionRotatedEvent = typeof SessionRotatedEvent.Type;

/** RRS-008: published by `Sessions.issue` when it tombstones the row named by `supersedes`. */
export const SessionSupersededEvent = Schema.TaggedStruct("auth.session.superseded", {
  sessionId: SessionIdSchema,
  supersededBy: SessionIdSchema,
  familyId: Schema.String,
  userId: UserIdSchema,
});
export type SessionSupersededEvent = typeof SessionSupersededEvent.Type;

/** TIR-008/ESA-006: why a session ended — supplied by the caller of every `Sessions` revocation primitive. */
export const SessionRevocationReason = Schema.Literals([
  "signOut",
  "userRevoked",
  "passwordChanged",
  "passwordReset",
  /** BEH-EA-053: a confirmed email change ends every session of the account. */
  "emailChanged",
  "userDeleted",
  "impersonationStopped",
  "admin",
  /** SCP-001/BAM-005: every session of a user ended because the account was suspended/banned. */
  "suspended",
  "reuseDetected",
  /** SMS-003: evicted by `SessionConfig.maxConcurrent` when the user's newest session was issued. */
  "limitEvicted",
]);
export type SessionRevocationReason = typeof SessionRevocationReason.Type;

/**
 * TIR-008/ESA-006: published by `Sessions`' own revocation primitives
 * (`revoke`, `revokeOwned`, `revokeOthers`, `revokeAll`, and reuse-detection's
 * family revocation), so every revocation path is observable and lands in
 * `AuditLog` — sign-out, account deletion and admin stops included, not just
 * the password plugin's bulk revocations. `sessionId` is the ended row for
 * `scope: "one"` and `null` for a bulk scope, which has no single row to name.
 */
export const SessionRevokedEvent = Schema.TaggedStruct("auth.session.revoked", {
  userId: UserIdSchema,
  sessionId: Schema.NullOr(SessionIdSchema),
  scope: Schema.Literals(["one", "others", "all", "family"]),
  reason: SessionRevocationReason,
});
export type SessionRevokedEvent = typeof SessionRevokedEvent.Type;

/**
 * ESA-006: published when `Sessions.verify` observes that a presented session
 * (with its correct secret) is past its absolute or idle expiry. Lazy: there
 * is no background reaper (CSG-003), so an expiry is only observed when the
 * expired credential is presented, and each such presentation publishes one.
 */
export const SessionExpiredEvent = Schema.TaggedStruct("auth.session.expired", {
  sessionId: SessionIdSchema,
  userId: UserIdSchema,
  kind: Schema.Literals(["absolute", "idle"]),
});
export type SessionExpiredEvent = typeof SessionExpiredEvent.Type;

/** ALF-004: published by `@awthaq/password`'s `changePassword`, after the new hash is persisted. */
export const PasswordChangedEvent = Schema.TaggedStruct("auth.password.changed", {
  userId: UserIdSchema,
});
export type PasswordChangedEvent = typeof PasswordChangedEvent.Type;

/**
 * ARF-006: published by `@awthaq/password`'s `requestReset` when a real account
 * exists — the earliest takeover signal, the hook for out-of-band owner
 * notification. Published from inside the detached mail branch, so it never
 * reintroduces the enumeration side channel (the response path is unchanged).
 */
export const PasswordResetRequestedEvent = Schema.TaggedStruct("auth.password.resetRequested", {
  userId: UserIdSchema,
});
export type PasswordResetRequestedEvent = typeof PasswordResetRequestedEvent.Type;

/** ALF-004: published by `@awthaq/password`'s `confirmReset`, once the transaction (consume + rehash + revoke) has committed. */
export const PasswordResetCompletedEvent = Schema.TaggedStruct("auth.password.resetCompleted", {
  userId: UserIdSchema,
});
export type PasswordResetCompletedEvent = typeof PasswordResetCompletedEvent.Type;

/**
 * Published by `@awthaq/passkey`'s authentication ceremony (BEH-EA-131,
 * ticket 08): a verified assertion's reported counter did not exceed the
 * stored one — "log + step-up, not an instant kill" per that ticket's own
 * language, so the session still issues and this event is the whole
 * response to the anomaly, not a request-level failure.
 */
export const PasskeyCounterAnomalyEvent = Schema.TaggedStruct("auth.passkey.counterAnomaly", {
  userId: UserIdSchema,
  credentialId: Schema.String,
});
export type PasskeyCounterAnomalyEvent = typeof PasskeyCounterAnomalyEvent.Type;

/**
 * Published by `@awthaq/admin`'s `impersonate`, on success (BEH-EA-218).
 * `reason` is the BEH-EA-218 justification — free text an admin typed, so it
 * is declared PII (`PII_FIELDS`) and scrubbed when the target/admin is erased.
 */
export const AdminImpersonationStartedEvent = Schema.TaggedStruct(
  "auth.admin.impersonationStarted",
  {
    adminUserId: UserIdSchema,
    targetUserId: UserIdSchema,
    reason: Schema.String,
    sessionId: SessionIdSchema,
  },
);
export type AdminImpersonationStartedEvent = typeof AdminImpersonationStartedEvent.Type;

/** Published by `@awthaq/admin`'s `stopImpersonating`/`forceStop` (BEH-EA-218). IDS-006: names both parties, so a SIEM need not join `ImpersonationRecords`. */
export const AdminImpersonationStoppedEvent = Schema.TaggedStruct(
  "auth.admin.impersonationStopped",
  {
    sessionId: SessionIdSchema,
    adminUserId: UserIdSchema,
    targetUserId: UserIdSchema,
    endedBy: Schema.Literals(["self", "forcedByAdmin", "expired"]),
  },
);
export type AdminImpersonationStoppedEvent = typeof AdminImpersonationStoppedEvent.Type;

/**
 * Published by `@awthaq/admin`'s `impersonate`/`forceStop`/`list`, but
 * only for a genuine `AdminConfig.canImpersonate` rejection — never for
 * self-impersonation, nested-impersonation, or an unknown target/session,
 * which are ordinary validation failures (BEH-EA-218's own "not diluted with
 * input-error noise" reasoning). IDS-006: `operation` says which call was
 * refused, and the attempted `targetUserId`/`sessionId` are carried when the
 * call named one.
 */
export const AdminImpersonationDeniedEvent = Schema.TaggedStruct("auth.admin.impersonationDenied", {
  adminUserId: UserIdSchema,
  operation: Schema.Literals(["impersonate", "forceStop", "list"]),
  targetUserId: Schema.optionalKey(UserIdSchema),
  sessionId: Schema.optionalKey(SessionIdSchema),
});
export type AdminImpersonationDeniedEvent = typeof AdminImpersonationDeniedEvent.Type;

/**
 * BAM-005: published by `@awthaq/admin` when an admin capability other than
 * impersonation (`AdminConfig.canManageUsers`) resolves `false` — the same
 * "genuine authorization rejection, never input-validation noise" signal
 * `auth.admin.impersonationDenied` is for impersonation. `action` names the
 * endpoint (`"listUsers"`, `"updateUser"`, ...).
 */
export const AdminActionDeniedEvent = Schema.TaggedStruct("auth.admin.actionDenied", {
  adminUserId: UserIdSchema,
  action: Schema.String,
});
export type AdminActionDeniedEvent = typeof AdminActionDeniedEvent.Type;

/** BAM-005: published by `@awthaq/admin`'s `updateUser`, after the profile change is persisted. */
export const AdminUserUpdatedEvent = Schema.TaggedStruct("auth.admin.userUpdated", {
  adminUserId: UserIdSchema,
  userId: UserIdSchema,
});
export type AdminUserUpdatedEvent = typeof AdminUserUpdatedEvent.Type;

/**
 * BAM-005: published by `@awthaq/admin`'s `revokeUserSession`/`revokeUserSessions`.
 * `sessionId` is the one revoked session, or `null` when every non-impersonation
 * session of `userId` was revoked in one call.
 */
export const AdminSessionRevokedEvent = Schema.TaggedStruct("auth.admin.sessionRevoked", {
  adminUserId: UserIdSchema,
  userId: UserIdSchema,
  sessionId: Schema.NullOr(SessionIdSchema),
});
export type AdminSessionRevokedEvent = typeof AdminSessionRevokedEvent.Type;

/**
 * BAM-005/SCP-001: published by `@awthaq/admin`'s `banUser`, after `Users.setStatus("suspended")`
 * and `Sessions.revokeAll(userId, "suspended")` both completed. `reason`/`until` are the
 * operator's note and the optional expiry (ISO instant), `null` when not given.
 */
export const AdminUserBannedEvent = Schema.TaggedStruct("auth.admin.userBanned", {
  adminUserId: UserIdSchema,
  userId: UserIdSchema,
  reason: Schema.NullOr(Schema.String),
  until: Schema.NullOr(Schema.String),
});
export type AdminUserBannedEvent = typeof AdminUserBannedEvent.Type;

/** BAM-005: published by `@awthaq/admin`'s `unbanUser`, after `Users.setStatus("active")`. */
export const AdminUserUnbannedEvent = Schema.TaggedStruct("auth.admin.userUnbanned", {
  adminUserId: UserIdSchema,
  userId: UserIdSchema,
});
export type AdminUserUnbannedEvent = typeof AdminUserUnbannedEvent.Type;

/**
 * BAM-005: published by `@awthaq/admin`'s `AdminAccounts.deleteUser` after the erasure cascade
 * committed. The erasure itself is announced by `auth.user.deleted` (`deletedBy: "admin"`); this
 * one names *which administrator* did it.
 */
export const AdminUserDeletedEvent = Schema.TaggedStruct("auth.admin.userDeleted", {
  adminUserId: UserIdSchema,
  userId: UserIdSchema,
});
export type AdminUserDeletedEvent = typeof AdminUserDeletedEvent.Type;

/**
 * BAM-005/BAM-009: published by `AdminAccounts.setUserEmail` once the confirmation mail to the new
 * address went out. The address is not changed yet: its owner completes the change from the mail.
 * No address in the payload (ADR-EA-029).
 */
export const AdminUserEmailChangeRequestedEvent = Schema.TaggedStruct(
  "auth.admin.userEmailChangeRequested",
  {
    adminUserId: UserIdSchema,
    userId: UserIdSchema,
  },
);
export type AdminUserEmailChangeRequestedEvent = typeof AdminUserEmailChangeRequestedEvent.Type;

/**
 * BAM-005: published by `AdminAccounts.setUserPassword` after the credential hash was replaced and
 * every session of the user was revoked (reason `admin`).
 */
export const AdminUserPasswordSetEvent = Schema.TaggedStruct("auth.admin.userPasswordSet", {
  adminUserId: UserIdSchema,
  userId: UserIdSchema,
});
export type AdminUserPasswordSetEvent = typeof AdminUserPasswordSetEvent.Type;

/**
 * EP-003 (ADR-EA-018): published by `@awthaq/admin`'s `AdminTenants.suspendOrganization`,
 * after the organization is marked suspended. `reason` is the operator's note, `null`
 * when none was given.
 */
export const AdminOrganizationSuspendedEvent = Schema.TaggedStruct(
  "auth.admin.organizationSuspended",
  {
    adminUserId: UserIdSchema,
    organizationId: Schema.String,
    reason: Schema.NullOr(Schema.String),
  },
);
export type AdminOrganizationSuspendedEvent = typeof AdminOrganizationSuspendedEvent.Type;

/** EP-003: published by `AdminTenants.unsuspendOrganization`, after the suspension is lifted. */
export const AdminOrganizationUnsuspendedEvent = Schema.TaggedStruct(
  "auth.admin.organizationUnsuspended",
  {
    adminUserId: UserIdSchema,
    organizationId: Schema.String,
  },
);
export type AdminOrganizationUnsuspendedEvent = typeof AdminOrganizationUnsuspendedEvent.Type;

/**
 * CWM-002 (ADR-EA-023): published by `@awthaq/scim` when a directory connection provisions a
 * user (a repeat `POST` that converges on an existing one publishes nothing). `connectionId`
 * names the SCIM connection, `organizationId` its organization.
 */
export const ScimUserProvisionedEvent = Schema.TaggedStruct("auth.scim.userProvisioned", {
  connectionId: Schema.String,
  organizationId: Schema.String,
  userId: UserIdSchema,
});
export type ScimUserProvisionedEvent = typeof ScimUserProvisionedEvent.Type;

/** CWM-002: published after a SCIM `active: false` (or `DELETE`, by default) suspended the user and revoked every session. */
export const ScimUserDeactivatedEvent = Schema.TaggedStruct("auth.scim.userDeactivated", {
  connectionId: Schema.String,
  organizationId: Schema.String,
  userId: UserIdSchema,
});
export type ScimUserDeactivatedEvent = typeof ScimUserDeactivatedEvent.Type;

/** CWM-002: published after a SCIM `active: true` lifted a suspension that same connection made. */
export const ScimUserReactivatedEvent = Schema.TaggedStruct("auth.scim.userReactivated", {
  connectionId: Schema.String,
  organizationId: Schema.String,
  userId: UserIdSchema,
});
export type ScimUserReactivatedEvent = typeof ScimUserReactivatedEvent.Type;

/** CWM-002: published after a SCIM `DELETE` configured to erase removed the user. */
export const ScimUserDeletedEvent = Schema.TaggedStruct("auth.scim.userDeleted", {
  connectionId: Schema.String,
  organizationId: Schema.String,
  userId: UserIdSchema,
});
export type ScimUserDeletedEvent = typeof ScimUserDeletedEvent.Type;

/** CWM-002: published when a SCIM connection creates, updates or deletes a group (an organization team). */
export const ScimGroupChangedEvent = Schema.TaggedStruct("auth.scim.groupChanged", {
  connectionId: Schema.String,
  organizationId: Schema.String,
  teamId: Schema.String,
  change: Schema.Literals(["created", "updated", "deleted"]),
});
export type ScimGroupChangedEvent = typeof ScimGroupChangedEvent.Type;

/**
 * ECS-006: published by `awthaq seed admin` after it grants the administrative role
 * (BEH-EA-206). `outcome` says whether the account was created or an existing one
 * promoted; `forced` that the grant went past an existing administrator. Carries the
 * user id and the role, never the address.
 */
export const AdminSeededEvent = Schema.TaggedStruct("auth.admin.seeded", {
  targetUserId: UserIdSchema,
  outcome: Schema.Literals(["created", "promoted"]),
  forced: Schema.Boolean,
  role: Schema.String,
  via: Schema.Literal("cli"),
});
export type AdminSeededEvent = typeof AdminSeededEvent.Type;

/** ECS-006: `awthaq seed admin` refused because an administrator already exists (and `--force` was not given). No address: the refusal names a reason, not a person. */
export const AdminSeedRefusedEvent = Schema.TaggedStruct("auth.admin.seedRefused", {
  reason: Schema.Literal("adminExists"),
});
export type AdminSeedRefusedEvent = typeof AdminSeedRefusedEvent.Type;

/** ECS-002: one `awthaq import --yes` run finished — every source row was imported, skipped or failed. */
export const ImportCompletedEvent = Schema.TaggedStruct("auth.import.completed", {
  source: Schema.String,
  runId: Schema.String,
  imported: Schema.Number,
  skipped: Schema.Number,
  failed: Schema.Number,
  unmapped: Schema.Number,
});
export type ImportCompletedEvent = typeof ImportCompletedEvent.Type;

/** ECS-002: one `awthaq import --yes` run stopped on a failed batch (counts are those reached so far). */
export const ImportFailedEvent = Schema.TaggedStruct("auth.import.failed", {
  source: Schema.String,
  runId: Schema.String,
  imported: Schema.Number,
  skipped: Schema.Number,
  failed: Schema.Number,
  unmapped: Schema.Number,
});
export type ImportFailedEvent = typeof ImportFailedEvent.Type;

/** Published by `@awthaq/organization`'s `create`. */
export const OrganizationCreatedEvent = Schema.TaggedStruct("auth.organization.created", {
  organizationId: Schema.String,
  creatorUserId: UserIdSchema,
});
export type OrganizationCreatedEvent = typeof OrganizationCreatedEvent.Type;

/** Published by `@awthaq/organization`'s `update`. */
export const OrganizationUpdatedEvent = Schema.TaggedStruct("auth.organization.updated", {
  organizationId: Schema.String,
});
export type OrganizationUpdatedEvent = typeof OrganizationUpdatedEvent.Type;

/** Published by `@awthaq/organization`'s `delete`. */
export const OrganizationDeletedEvent = Schema.TaggedStruct("auth.organization.deleted", {
  organizationId: Schema.String,
});
export type OrganizationDeletedEvent = typeof OrganizationDeletedEvent.Type;

/** Published by `@awthaq/organization`'s `create` (the creator's own membership) and `addMember`. */
export const OrganizationMemberAddedEvent = Schema.TaggedStruct("auth.organization.memberAdded", {
  organizationId: Schema.String,
  userId: UserIdSchema,
  role: RoleNames,
});
export type OrganizationMemberAddedEvent = typeof OrganizationMemberAddedEvent.Type;

/** Published by `@awthaq/organization`'s `removeMember`/`leave`. */
export const OrganizationMemberRemovedEvent = Schema.TaggedStruct(
  "auth.organization.memberRemoved",
  { organizationId: Schema.String, userId: UserIdSchema },
);
export type OrganizationMemberRemovedEvent = typeof OrganizationMemberRemovedEvent.Type;

/** Published by `@awthaq/organization`'s `updateMemberRole`. */
export const OrganizationMemberRoleUpdatedEvent = Schema.TaggedStruct(
  "auth.organization.memberRoleUpdated",
  { organizationId: Schema.String, userId: UserIdSchema, role: RoleNames },
);
export type OrganizationMemberRoleUpdatedEvent = typeof OrganizationMemberRoleUpdatedEvent.Type;

/**
 * Published by `@awthaq/organization`'s `invite`. ESA-005: identifiers only — the
 * invitee's email is *not* on the bus or in the audit row; a subscriber that needs
 * it resolves `invitationId` through the invitation record store, which the
 * erasure cascade owns.
 */
export const OrganizationInvitationCreatedEvent = Schema.TaggedStruct(
  "auth.organization.invitationCreated",
  { invitationId: Schema.String, organizationId: Schema.String },
);
export type OrganizationInvitationCreatedEvent = typeof OrganizationInvitationCreatedEvent.Type;

/** Published by `@awthaq/organization`'s `accept`. */
export const OrganizationInvitationAcceptedEvent = Schema.TaggedStruct(
  "auth.organization.invitationAccepted",
  { invitationId: Schema.String, organizationId: Schema.String, userId: UserIdSchema },
);
export type OrganizationInvitationAcceptedEvent = typeof OrganizationInvitationAcceptedEvent.Type;

/** Published by `@awthaq/organization`'s `reject`. */
export const OrganizationInvitationRejectedEvent = Schema.TaggedStruct(
  "auth.organization.invitationRejected",
  { invitationId: Schema.String, organizationId: Schema.String },
);
export type OrganizationInvitationRejectedEvent = typeof OrganizationInvitationRejectedEvent.Type;

/** Published by `@awthaq/organization`'s `cancel`. */
export const OrganizationInvitationCanceledEvent = Schema.TaggedStruct(
  "auth.organization.invitationCanceled",
  { invitationId: Schema.String, organizationId: Schema.String },
);
export type OrganizationInvitationCanceledEvent = typeof OrganizationInvitationCanceledEvent.Type;

/** Published by `@awthaq/organization`'s `createRole`. */
export const OrganizationRoleCreatedEvent = Schema.TaggedStruct("auth.organization.roleCreated", {
  organizationId: Schema.String,
  role: Schema.String,
});
export type OrganizationRoleCreatedEvent = typeof OrganizationRoleCreatedEvent.Type;

/** Published by `@awthaq/organization`'s `updateRole`. */
export const OrganizationRoleUpdatedEvent = Schema.TaggedStruct("auth.organization.roleUpdated", {
  organizationId: Schema.String,
  role: Schema.String,
});
export type OrganizationRoleUpdatedEvent = typeof OrganizationRoleUpdatedEvent.Type;

/** Published by `@awthaq/organization`'s `deleteRole`. */
export const OrganizationRoleDeletedEvent = Schema.TaggedStruct("auth.organization.roleDeleted", {
  organizationId: Schema.String,
  role: Schema.String,
});
export type OrganizationRoleDeletedEvent = typeof OrganizationRoleDeletedEvent.Type;

/** Published by `@awthaq/organization`'s `createTeam`. */
export const OrganizationTeamCreatedEvent = Schema.TaggedStruct("auth.organization.teamCreated", {
  organizationId: Schema.String,
  teamId: Schema.String,
});
export type OrganizationTeamCreatedEvent = typeof OrganizationTeamCreatedEvent.Type;

/** Published by `@awthaq/organization`'s `updateTeam`. */
export const OrganizationTeamUpdatedEvent = Schema.TaggedStruct("auth.organization.teamUpdated", {
  organizationId: Schema.String,
  teamId: Schema.String,
});
export type OrganizationTeamUpdatedEvent = typeof OrganizationTeamUpdatedEvent.Type;

/** OHS-001: published by `@awthaq/organization`'s `moveTeam`; `parentId` is `null` when the team became a root. */
export const OrganizationTeamMovedEvent = Schema.TaggedStruct("auth.organization.teamMoved", {
  organizationId: Schema.String,
  teamId: Schema.String,
  parentId: Schema.NullOr(Schema.String),
});
export type OrganizationTeamMovedEvent = typeof OrganizationTeamMovedEvent.Type;

/** Published by `@awthaq/organization`'s `removeTeam`. */
export const OrganizationTeamDeletedEvent = Schema.TaggedStruct("auth.organization.teamDeleted", {
  organizationId: Schema.String,
  teamId: Schema.String,
});
export type OrganizationTeamDeletedEvent = typeof OrganizationTeamDeletedEvent.Type;

/** Published by `@awthaq/organization`'s `addTeamMember` (and `acceptInvitation` for a team-targeted invitation). */
export const OrganizationTeamMemberAddedEvent = Schema.TaggedStruct(
  "auth.organization.teamMemberAdded",
  { organizationId: Schema.String, teamId: Schema.String, userId: UserIdSchema },
);
export type OrganizationTeamMemberAddedEvent = typeof OrganizationTeamMemberAddedEvent.Type;

/** OHS-004: published by `@awthaq/organization`'s `updateTeamMemberRole`. */
export const OrganizationTeamMemberRoleUpdatedEvent = Schema.TaggedStruct(
  "auth.organization.teamMemberRoleUpdated",
  {
    organizationId: Schema.String,
    teamId: Schema.String,
    userId: UserIdSchema,
    role: RoleNames,
  },
);
export type OrganizationTeamMemberRoleUpdatedEvent =
  typeof OrganizationTeamMemberRoleUpdatedEvent.Type;

/** Published by `@awthaq/organization`'s `removeTeamMember`. */
export const OrganizationTeamMemberRemovedEvent = Schema.TaggedStruct(
  "auth.organization.teamMemberRemoved",
  { organizationId: Schema.String, teamId: Schema.String, userId: UserIdSchema },
);
export type OrganizationTeamMemberRemovedEvent = typeof OrganizationTeamMemberRemovedEvent.Type;

/**
 * Published by `@awthaq/organization` whenever its own `PermissionEngine`
 * gating denies an operation (PERS-005) — the plugin authorizes without a
 * qadi round trip, so without this its denials would leave no durable record.
 * `reason` says why: the caller is not a member (`notMember`, answered to the
 * caller as a 404) or is a member without the statement (`missingStatement`).
 */
export const OrganizationPermissionDeniedEvent = Schema.TaggedStruct(
  "auth.organization.permissionDenied",
  {
    organizationId: Schema.String,
    userId: UserIdSchema,
    resource: Schema.String,
    action: Schema.String,
    reason: Schema.Literals(["notMember", "missingStatement"]),
  },
);
export type OrganizationPermissionDeniedEvent = typeof OrganizationPermissionDeniedEvent.Type;

/**
 * Published by `@awthaq/qadi`'s `DecisionSinkAudit` for every authorization
 * denial qadi's evaluator reaches (TS-003) — which policy denied which
 * subject, durably, without the operator writing a sink of their own.
 * `subjectId` is qadi's own subject id (`user:<id>`, `apikey:<id>`,
 * `anonymous`, ...); `reason` is qadi's denial sentence (it names attributes,
 * never their values).
 */
export const AuthorizationDeniedEvent = Schema.TaggedStruct("auth.authz.denied", {
  subjectId: Schema.String,
  evaluationId: Schema.String,
  policyTag: Schema.String,
  action: Schema.optional(Schema.String),
  reason: Schema.String,
});
export type AuthorizationDeniedEvent = typeof AuthorizationDeniedEvent.Type;

/**
 * Published by `@awthaq/roles`' `assign`/`revoke` on a *real* change of a
 * user's global role assignments (RRM-005): a re-assign or a revoke of a role
 * the user never held publishes nothing. `userId` is the user whose roles
 * changed; `actorUserId` the operator who changed them, when the caller said —
 * `Roles` is a trusted primitive, so an application-driven change has none.
 */
export const RolesAssignedEvent = Schema.TaggedStruct("auth.roles.assigned", {
  userId: UserIdSchema,
  roleName: Schema.String,
  actorUserId: Schema.optional(UserIdSchema),
});
export type RolesAssignedEvent = typeof RolesAssignedEvent.Type;

/**
 * FAMS-004: published by `@awthaq/qadi`'s `UserClaims` on a real change. `keys` names the
 * claim keys that changed — never their values, which may be sensitive and must not enter the
 * audit trail; `actorUserId` is who made the change, when known.
 */
export const UserClaimsUpdatedEvent = Schema.TaggedStruct("auth.user.claimsUpdated", {
  userId: UserIdSchema,
  keys: Schema.Array(Schema.String),
  actorUserId: Schema.optional(UserIdSchema),
});
export type UserClaimsUpdatedEvent = typeof UserClaimsUpdatedEvent.Type;

/** Published by `@awthaq/roles`' `revoke` (see `RolesAssignedEvent`). */
export const RolesRevokedEvent = Schema.TaggedStruct("auth.roles.revoked", {
  userId: UserIdSchema,
  roleName: Schema.String,
  actorUserId: Schema.optional(UserIdSchema),
});
export type RolesRevokedEvent = typeof RolesRevokedEvent.Type;

/**
 * EOTS-007: published by `RateLimits.enforce` on every rate-limit breach.
 * Deliberately carries no bucket key, email or IP (BEH-EA-108): it names the
 * rule that fired, so a defender can see which throttle is being hit and how
 * often without the event stream itself becoming an identifier oracle.
 */
export const RateLimitExceededEvent = Schema.TaggedStruct("auth.rateLimit.exceeded", {
  group: Schema.String,
  endpoint: Schema.String,
  rule: Schema.String,
  dimension: Schema.Literals(["identity", "ip", "principal", "custom"]),
  retryAfterMillis: Schema.Number,
});
export type RateLimitExceededEvent = typeof RateLimitExceededEvent.Type;

/**
 * ERS-002: published by `MailDispatch` when a mail that was accepted for
 * background delivery could not be delivered after its retries (or failed
 * permanently) — the one signal that a verification/reset mail was lost,
 * since the request that triggered it already answered uniformly. Carries the
 * template and, when known, the user it concerned, never the recipient
 * address or any token (EOTS-010).
 */
export const MailFailedEvent = Schema.TaggedStruct("auth.mail.failed", {
  template: Schema.String,
  userId: Schema.optionalKey(UserIdSchema),
});
export type MailFailedEvent = typeof MailFailedEvent.Type;

/**
 * OCM-002/OCM-005 (`@awthaq/api-key`): the lifecycle of a long-lived API key and of a
 * `client_credentials` client. `userId` is the owner who acted; `keyId`/`clientId`
 * are the public ids (never a secret or a hash). `rotated` names the predecessor
 * (`keyId`) and its successor.
 */
export const ApiKeyCreatedEvent = Schema.TaggedStruct("auth.apiKey.created", {
  userId: UserIdSchema,
  keyId: Schema.String,
});
export type ApiKeyCreatedEvent = typeof ApiKeyCreatedEvent.Type;

export const ApiKeyRevokedEvent = Schema.TaggedStruct("auth.apiKey.revoked", {
  userId: UserIdSchema,
  keyId: Schema.String,
});
export type ApiKeyRevokedEvent = typeof ApiKeyRevokedEvent.Type;

export const ApiKeyRotatedEvent = Schema.TaggedStruct("auth.apiKey.rotated", {
  userId: UserIdSchema,
  keyId: Schema.String,
  successorKeyId: Schema.String,
});
export type ApiKeyRotatedEvent = typeof ApiKeyRotatedEvent.Type;

export const ApiKeyClientRegisteredEvent = Schema.TaggedStruct("auth.apiKey.clientRegistered", {
  userId: UserIdSchema,
  clientId: Schema.String,
});
export type ApiKeyClientRegisteredEvent = typeof ApiKeyClientRegisteredEvent.Type;

export const ApiKeyClientRevokedEvent = Schema.TaggedStruct("auth.apiKey.clientRevoked", {
  userId: UserIdSchema,
  clientId: Schema.String,
});
export type ApiKeyClientRevokedEvent = typeof ApiKeyClientRevokedEvent.Type;

export const ApiKeyClientSecretRotatedEvent = Schema.TaggedStruct(
  "auth.apiKey.clientSecretRotated",
  {
    userId: UserIdSchema,
    clientId: Schema.String,
  },
);
export type ApiKeyClientSecretRotatedEvent = typeof ApiKeyClientSecretRotatedEvent.Type;

/**
 * THS-001/AOMS-003/BCR-006 (`@awthaq/two-factor`): the second factor's lifecycle and every
 * failed or successful presentation, so a defender can see enrolment, use of a recovery code
 * (the sign that a device was lost), and lockouts. Identifiers only: no code, secret or hash.
 * `method` names which factor was presented; `purpose` what it was presented for.
 */
export const TwoFactorMethod = Schema.Literals(["totp", "recovery"]);
export type TwoFactorMethod = typeof TwoFactorMethod.Type;

export const TwoFactorPurpose = Schema.Literals([
  "enroll",
  "signIn",
  "credentialReset",
  "disable",
  "regenerate",
]);
export type TwoFactorPurpose = typeof TwoFactorPurpose.Type;

/** Published when a pending secret is confirmed with a first valid code — the factor is now active. */
export const TwoFactorEnabledEvent = Schema.TaggedStruct("auth.twoFactor.enabled", {
  userId: UserIdSchema,
});
export type TwoFactorEnabledEvent = typeof TwoFactorEnabledEvent.Type;

/** Published when the factor is removed (secret and recovery codes deleted). */
export const TwoFactorDisabledEvent = Schema.TaggedStruct("auth.twoFactor.disabled", {
  userId: UserIdSchema,
});
export type TwoFactorDisabledEvent = typeof TwoFactorDisabledEvent.Type;

/** Published on every successful presentation of a second factor, with the method used. */
export const TwoFactorVerifiedEvent = Schema.TaggedStruct("auth.twoFactor.verified", {
  userId: UserIdSchema,
  method: TwoFactorMethod,
  purpose: TwoFactorPurpose,
});
export type TwoFactorVerifiedEvent = typeof TwoFactorVerifiedEvent.Type;

/** Published on every failed presentation (wrong code, replayed step, unknown recovery code). */
export const TwoFactorChallengeFailedEvent = Schema.TaggedStruct("auth.twoFactor.challengeFailed", {
  userId: UserIdSchema,
  method: TwoFactorMethod,
  purpose: TwoFactorPurpose,
});
export type TwoFactorChallengeFailedEvent = typeof TwoFactorChallengeFailedEvent.Type;

/** Published when a recovery code is spent; `remaining` is what is left, for a low-supply warning. */
export const TwoFactorRecoveryCodeUsedEvent = Schema.TaggedStruct(
  "auth.twoFactor.recoveryCodeUsed",
  {
    userId: UserIdSchema,
    remaining: Schema.Number,
  },
);
export type TwoFactorRecoveryCodeUsedEvent = typeof TwoFactorRecoveryCodeUsedEvent.Type;

/** Published when the recovery codes are replaced by a fresh set (the old set is invalid). */
export const TwoFactorRecoveryCodesRegeneratedEvent = Schema.TaggedStruct(
  "auth.twoFactor.recoveryCodesRegenerated",
  { userId: UserIdSchema },
);
export type TwoFactorRecoveryCodesRegeneratedEvent =
  typeof TwoFactorRecoveryCodesRegeneratedEvent.Type;

/** BCR-006: the shared per-account failure budget was exhausted; the second factor is locked for the window. */
export const TwoFactorLockedEvent = Schema.TaggedStruct("auth.twoFactor.locked", {
  userId: UserIdSchema,
});
export type TwoFactorLockedEvent = typeof TwoFactorLockedEvent.Type;

/**
 * BEH-EA-306 (`@awthaq/device-authorization`): a person's decision on a device grant. `userId` is
 * the approver, `clientId` the registered client that asked. The user code, the device code, their
 * hashes and the scope are never carried: identifiers only (ADR-EA-029). The session the approved
 * grant later becomes is announced by the ordinary `auth.session.issued` / `auth.user.signedIn`
 * (strategy `deviceAuthorization`).
 */
export const DeviceAuthorizationApprovedEvent = Schema.TaggedStruct(
  "auth.deviceAuthorization.approved",
  { userId: UserIdSchema, clientId: Schema.String },
);
export type DeviceAuthorizationApprovedEvent = typeof DeviceAuthorizationApprovedEvent.Type;

export const DeviceAuthorizationDeniedEvent = Schema.TaggedStruct(
  "auth.deviceAuthorization.denied",
  { userId: UserIdSchema, clientId: Schema.String },
);
export type DeviceAuthorizationDeniedEvent = typeof DeviceAuthorizationDeniedEvent.Type;

/** BEH-EA-101: the closed, statically-known set of event types `AuthEvents` carries. */
export const AuthEventSchema = Schema.Union([
  TokenReplayEvent,
  UserCreatedEvent,
  UserSignedInEvent,
  UserSignInFailedEvent,
  UserEmailVerifiedEvent,
  UserEmailChangedEvent,
  UserDeletedEvent,
  UserDataExportedEvent,
  SessionReuseEvent,
  SessionIssuedEvent,
  SessionRotatedEvent,
  SessionSupersededEvent,
  SessionRevokedEvent,
  SessionExpiredEvent,
  PasswordChangedEvent,
  PasswordResetRequestedEvent,
  PasswordResetCompletedEvent,
  PasskeyCounterAnomalyEvent,
  AdminImpersonationStartedEvent,
  AdminImpersonationStoppedEvent,
  AdminImpersonationDeniedEvent,
  AdminActionDeniedEvent,
  AdminUserUpdatedEvent,
  AdminUserBannedEvent,
  AdminUserUnbannedEvent,
  AdminUserDeletedEvent,
  AdminUserEmailChangeRequestedEvent,
  AdminUserPasswordSetEvent,
  AdminSessionRevokedEvent,
  AdminOrganizationSuspendedEvent,
  AdminOrganizationUnsuspendedEvent,
  ScimUserProvisionedEvent,
  ScimUserDeactivatedEvent,
  ScimUserReactivatedEvent,
  ScimUserDeletedEvent,
  ScimGroupChangedEvent,
  AdminSeededEvent,
  AdminSeedRefusedEvent,
  ImportCompletedEvent,
  ImportFailedEvent,
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
  AuthorizationDeniedEvent,
  RolesAssignedEvent,
  UserClaimsUpdatedEvent,
  RolesRevokedEvent,
  RateLimitExceededEvent,
  MailFailedEvent,
  ApiKeyCreatedEvent,
  ApiKeyRevokedEvent,
  ApiKeyRotatedEvent,
  ApiKeyClientRegisteredEvent,
  ApiKeyClientRevokedEvent,
  ApiKeyClientSecretRotatedEvent,
  TwoFactorEnabledEvent,
  TwoFactorDisabledEvent,
  TwoFactorVerifiedEvent,
  TwoFactorChallengeFailedEvent,
  TwoFactorRecoveryCodeUsedEvent,
  TwoFactorRecoveryCodesRegeneratedEvent,
  TwoFactorLockedEvent,
  DeviceAuthorizationApprovedEvent,
  DeviceAuthorizationDeniedEvent,
]);

export type AuthEvent = typeof AuthEventSchema.Type;

export type AuthEventTag = AuthEvent["_tag"];

/** Every event with the given tag(s) — what a tag-narrowed subscriber handler receives. */
export type EventOf<Tag extends AuthEventTag> = Extract<AuthEvent, { readonly _tag: Tag }>;

/**
 * ESA-002: what `publish` stamps once, so the `AuditLog` row and the bus event
 * are the same fact — a subscriber joins its delivered event to the durable row
 * through `eventId` (the row's `id`), and `occurredAt` is the row's timestamp.
 * `eventId` is a time-ordered (uuidv7-shaped), in-process-monotonic id, so ids
 * sort in publish order: it is also the cursor `AuditLog.replay` pages by.
 * ALF-006: `correlationId`/`ip`/`userAgent` come from `AuthRequestContext` (all
 * `None` outside an HTTP request); `traceId`/`spanId` identify the span that
 * was current at the publish site, so a subscriber can link back to it.
 */
export interface EventMetadata {
  readonly eventId: string;
  readonly occurredAt: DateTime.Utc;
  readonly correlationId: Option.Option<string>;
  readonly traceId: Option.Option<string>;
  readonly spanId: Option.Option<string>;
  readonly ip: Option.Option<string>;
  readonly userAgent: Option.Option<string>;
}

/** A delivered event: the payload plus its envelope. An intersection distributes over the union, so `_tag` narrowing still works. */
export type Published<E extends AuthEvent = AuthEvent> = E & EventMetadata;

// ---- versioning and the stored codec -------------------------------------------

/**
 * BEH-EA-101: the version of the *stored* event shape. A breaking payload
 * change bumps this and adds an upcaster for the previous version to
 * `upcastPayload`; rows written under an older version stay decodable.
 */
export const EVENT_VERSION = 1;

/**
 * Lifts a stored payload written under `version` to the current shape. Version
 * 1 is current, so this is the identity; a missing `version` is a row written
 * before versioning existed, whose payload *is* the version-1 event.
 */
export const upcastPayload = (_version: number, payload: unknown): unknown => payload;

export const decodeEvent = Schema.decodeUnknownEffect(AuthEventSchema);
/** The event alone, without its envelope (decoding keeps only the declared fields) — what tests and relays compare. Throws on a value that is not an `AuthEvent`. */
export const payloadOf = Schema.decodeUnknownSync(AuthEventSchema);
export const encodeEvent = Schema.encodeEffect(AuthEventSchema);

/**
 * ESA-005/ADR-EA-029: the payload fields that hold free text about a person,
 * per tag, scrubbed (set to `""`) when the person is erased. Everything else
 * an event carries is an identifier the erasure pass rewrites to a pseudonym.
 * A new event that carries free text must be listed here.
 */
export const PII_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "auth.admin.impersonationStarted": ["reason"],
};
