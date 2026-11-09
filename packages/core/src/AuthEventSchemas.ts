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
// `sessionId` as `SessionId`, through `EventDefinition.UserId`/`SessionId`
// (`@awthaq/ports`' `Ids`), the same brand names `Users.ts`/`Sessions.ts` use
// (`Brand.nominal<UserId>()`, `Brand.nominal<SessionId>()`), so the two are the
// same nominal type without this module importing either of them.
//
// PII posture (ESA-005, ADR-EA-029): payloads carry identifiers, never contact
// details or free text about a person. A subscriber that needs an email joins
// through the record store, which the erasure cascade owns. The exceptions are
// declared with the event (`EventDefinition.define`'s `pii`), so erasure can scrub them and
// the webhooks payload never sends them: the impersonation justification text.
//
// Every event is declared with `EventDefinition.define(tag, fields, { actor, pii })`
// (`EventDefinition.ts`): its shape, who acted (the audit row's actor
// column) and which fields hold free text about a person, checked against the
// event's own fields. `EventDefinition.make([...])` refuses a member without that declaration.

import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as EventDefinition from "./EventDefinition.ts";

const RoleNames = Schema.Array(Schema.String);

/** BEH-EA-059: published whenever `Verification.consume` fails — expired, unknown, or already-consumed alike (the same uniform-response reasoning as `TokenConsumed` itself). */
export const TokenReplayEvent = EventDefinition.define(
  "auth.token.replay",
  {
    identifier: Schema.String,
  },
  {
    actor: EventDefinition.Actor.none,
    pii: [],
    attempt: true,
  },
);
export type TokenReplayEvent = typeof TokenReplayEvent.Type;

/** Published by core's `SignUp` once a user-creating unit commits (password, OAuth, SAML, magic link, email OTP, SCIM). */
export const UserCreatedEvent = EventDefinition.define(
  "auth.user.created",
  { userId: EventDefinition.UserId },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type UserCreatedEvent = typeof UserCreatedEvent.Type;

/**
 * Published by core's `FederatedIdentity` when it joins an external identity to an existing account:
 * `emailMatch` (a trusted party's verified address matched a verified local user) or `explicit` (a signed-in
 * user linked a provider). No subject and no address: a SAML NameID is often an email (ADR-EA-029).
 */
export const AccountLinkedEvent = EventDefinition.define(
  "auth.account.linked",
  {
    userId: EventDefinition.UserId,
    providerId: Schema.String,
    via: Schema.Literals(["emailMatch", "explicit"]),
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type AccountLinkedEvent = typeof AccountLinkedEvent.Type;

/** Published by core's `SignIn` once a sign-in has completed (including a sign-up's first session). */
export const UserSignedInEvent = EventDefinition.define(
  "auth.user.signedIn",
  {
    userId: EventDefinition.UserId,
    strategy: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
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
export const UserSignInFailedEvent = EventDefinition.define(
  "auth.user.signInFailed",
  {
    strategy: Schema.String,
    reason: SignInFailureReason,
    /** The address the attempt came from (not `ip`, which is the envelope's own request-context field). */
    clientIp: Schema.optionalKey(Schema.String),
    identifierDigest: Schema.optionalKey(Schema.String),
  },
  {
    actor: EventDefinition.Actor.none,
    pii: [],
    attempt: true,
  },
);
export type UserSignInFailedEvent = typeof UserSignInFailedEvent.Type;

/**
 * SCP-006: published once a user's erasure has committed (`Erasure.AccountErasure`, the only
 * path). Deliberately no email: the row is being erased (ESA-005), and the audit rows that
 * outlive it are pseudonymized, not deleted. `deletedBy` names the initiator kind; the
 * initiator's own ids ride along (identifiers only, ADR-EA-029): `adminUserId` for "admin",
 * `connectionId`/`organizationId` for "directory". Rows written before these fields existed
 * decode unchanged (all optional).
 */
export const UserDeletedEvent = EventDefinition.define(
  "auth.user.deleted",
  {
    userId: EventDefinition.UserId,
    deletedBy: Schema.Literals(["self", "admin", "directory"]),
    adminUserId: Schema.optionalKey(EventDefinition.UserId),
    connectionId: Schema.optionalKey(Schema.String),
    organizationId: Schema.optionalKey(Schema.String),
  },
  {
    // receipt: the erased id stays the actor, whoever initiated (ADR-EA-029 §4).
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type UserDeletedEvent = typeof UserDeletedEvent.Type;

/**
 * CSG-005: published each time a data-subject export (GDPR Art. 15/20) is produced, so the
 * audit trail records who exported whose data. Ids only — the document itself is never an
 * event payload. `requestedBy` is the account holder (`"self"`) or an administrator acting
 * for them (`"admin"`).
 */
export const UserDataExportedEvent = EventDefinition.define(
  "auth.user.dataExported",
  {
    userId: EventDefinition.UserId,
    requestedBy: Schema.Literals(["self", "admin"]),
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type UserDataExportedEvent = typeof UserDataExportedEvent.Type;

/**
 * RRS-003: published by `Sessions.verify` the first time a tombstoned
 * (already-superseded) session token is presented again — refresh-token
 * reuse, the standard signal a token family has been compromised. Every
 * still-live row sharing `familyId` is revoked in the same call.
 */
export const SessionReuseEvent = EventDefinition.define(
  "auth.session.reuse",
  {
    sessionId: EventDefinition.SessionId,
    familyId: Schema.String,
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type SessionReuseEvent = typeof SessionReuseEvent.Type;

/**
 * ALF-004/ESA-006: published by `Sessions.issue` itself (both layers), so
 * every path that mints a session — password, OAuth, passkey, admin
 * impersonation, a legacy-session bridge, a `supersedes` rotation — emits
 * exactly one, with no plugin having to remember to.
 */
export const SessionIssuedEvent = EventDefinition.define(
  "auth.session.issued",
  {
    sessionId: EventDefinition.SessionId,
    userId: EventDefinition.UserId,
    /** RRS-003: the rotation family this session belongs to (its own id for a fresh family). */
    familyId: Schema.String,
    /** BEH-EA-209: present only for an impersonation session. */
    actingAs: Schema.optionalKey(Schema.Struct({ type: Schema.String, id: Schema.String })),
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type SessionIssuedEvent = typeof SessionIssuedEvent.Type;

/** RRS-008: published by `Sessions.verify` on the winning in-place secret rotation only (the concurrent loser reports `rotated: none` and publishes nothing), and by a grace-window recovery rotation (RRS-005). */
export const SessionRotatedEvent = EventDefinition.define(
  "auth.session.rotated",
  {
    sessionId: EventDefinition.SessionId,
    familyId: Schema.String,
    userId: EventDefinition.UserId,
    /** RRS-005: set when the rotation was triggered by the *previous* secret inside `SessionConfig.rotationGrace` — a client that missed the last delivery recovering, worth a detector's attention if frequent. */
    viaGrace: Schema.optional(Schema.Boolean),
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type SessionRotatedEvent = typeof SessionRotatedEvent.Type;

/** RRS-008: published by `Sessions.issue` when it tombstones the row named by `supersedes`. */
export const SessionSupersededEvent = EventDefinition.define(
  "auth.session.superseded",
  {
    sessionId: EventDefinition.SessionId,
    supersededBy: EventDefinition.SessionId,
    familyId: Schema.String,
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
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
  /** `@awthaq/saml`: a SAML Single Logout (the IdP's LogoutRequest, or the user's own logout through it) ended the session. */
  "federatedLogout",
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
export const SessionRevokedEvent = EventDefinition.define(
  "auth.session.revoked",
  {
    userId: EventDefinition.UserId,
    sessionId: Schema.NullOr(EventDefinition.SessionId),
    scope: Schema.Literals(["one", "others", "all", "family"]),
    reason: SessionRevocationReason,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type SessionRevokedEvent = typeof SessionRevokedEvent.Type;

/**
 * ESA-006: published when `Sessions.verify` observes that a presented session
 * (with its correct secret) is past its absolute or idle expiry. Lazy: there
 * is no background reaper (CSG-003), so an expiry is only observed when the
 * expired credential is presented, and each such presentation publishes one.
 */
export const SessionExpiredEvent = EventDefinition.define(
  "auth.session.expired",
  {
    sessionId: EventDefinition.SessionId,
    userId: EventDefinition.UserId,
    kind: Schema.Literals(["absolute", "idle"]),
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type SessionExpiredEvent = typeof SessionExpiredEvent.Type;

/** ALF-004: published by `@awthaq/password`'s `changePassword`, after the new hash is persisted. */
export const PasswordChangedEvent = EventDefinition.define(
  "auth.password.changed",
  {
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type PasswordChangedEvent = typeof PasswordChangedEvent.Type;

/**
 * Published by `@awthaq/passkey`'s authentication ceremony (BEH-EA-131,
 * ticket 08): a verified assertion's reported counter did not exceed the
 * stored one — "log + step-up, not an instant kill" per that ticket's own
 * language, so the session still issues and this event is the whole
 * response to the anomaly, not a request-level failure.
 */
export const PasskeyCounterAnomalyEvent = EventDefinition.define(
  "auth.passkey.counterAnomaly",
  {
    userId: EventDefinition.UserId,
    credentialId: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type PasskeyCounterAnomalyEvent = typeof PasskeyCounterAnomalyEvent.Type;

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

/**
 * Published by `@awthaq/admin`'s `impersonate`/`forceStop`/`list`, but
 * only for a genuine `AdminConfig.canImpersonate` rejection — never for
 * self-impersonation, nested-impersonation, or an unknown target/session,
 * which are ordinary validation failures (BEH-EA-218's own "not diluted with
 * input-error noise" reasoning). IDS-006: `operation` says which call was
 * refused, and the attempted `targetUserId`/`sessionId` are carried when the
 * call named one.
 */
export const AdminImpersonationDeniedEvent = EventDefinition.define(
  "auth.admin.impersonationDenied",
  {
    adminUserId: EventDefinition.UserId,
    operation: Schema.Literals(["impersonate", "forceStop", "list"]),
    targetUserId: Schema.optionalKey(EventDefinition.UserId),
    sessionId: Schema.optionalKey(EventDefinition.SessionId),
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
    attempt: true,
  },
);
export type AdminImpersonationDeniedEvent = typeof AdminImpersonationDeniedEvent.Type;

/**
 * BAM-005: published by `@awthaq/admin` when a user- or tenant-administration
 * predicate (`canManageUsers`, `canBanUsers`, `canDeleteUsers`,
 * `canManageCredentials`, `canAdministerTenants`) resolves `false` — the same
 * "genuine authorization rejection, never input-validation noise" signal
 * `auth.admin.impersonationDenied` is for impersonation. `action` names the
 * endpoint (`"listUsers"`, `"updateUser"`, ...). Like IDS-006, `targetUserId`
 * (user administration) or `organizationId` (tenant administration) is carried
 * when the call named one. `@awthaq/saml` and `@awthaq/webhooks` publish it too
 * (with a prefixed `action`), without either key.
 */
export const AdminActionDeniedEvent = EventDefinition.define(
  "auth.admin.actionDenied",
  {
    adminUserId: EventDefinition.UserId,
    action: Schema.String,
    targetUserId: Schema.optionalKey(EventDefinition.UserId),
    organizationId: Schema.optionalKey(Schema.String),
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
    attempt: true,
  },
);
export type AdminActionDeniedEvent = typeof AdminActionDeniedEvent.Type;

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

/**
 * EP-003 (ADR-EA-018): published by `@awthaq/admin`'s `AdminTenants.suspendOrganization`,
 * after the organization is marked suspended. `reason` is the operator's note, `null`
 * when none was given; operators write free text there, so it is declared `pii`.
 */
export const AdminOrganizationSuspendedEvent = EventDefinition.define(
  "auth.admin.organizationSuspended",
  {
    adminUserId: EventDefinition.UserId,
    organizationId: Schema.String,
    reason: Schema.NullOr(Schema.String),
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: ["reason"],
  },
);
export type AdminOrganizationSuspendedEvent = typeof AdminOrganizationSuspendedEvent.Type;

/** EP-003: published by `AdminTenants.unsuspendOrganization`, after the suspension is lifted. */
export const AdminOrganizationUnsuspendedEvent = EventDefinition.define(
  "auth.admin.organizationUnsuspended",
  {
    adminUserId: EventDefinition.UserId,
    organizationId: Schema.String,
  },
  {
    actor: EventDefinition.Actor.field("adminUserId"),
    pii: [],
  },
);
export type AdminOrganizationUnsuspendedEvent = typeof AdminOrganizationUnsuspendedEvent.Type;

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

/**
 * ECS-006: published by `awthaq seed admin` after it grants the administrative role
 * (BEH-EA-206). `outcome` says whether the account was created or an existing one
 * promoted; `forced` that the grant went past an existing administrator. Carries the
 * user id and the role, never the address.
 */
export const AdminSeededEvent = EventDefinition.define(
  "auth.admin.seeded",
  {
    targetUserId: EventDefinition.UserId,
    outcome: Schema.Literals(["created", "promoted"]),
    forced: Schema.Boolean,
    role: Schema.String,
    via: Schema.Literal("cli"),
  },
  {
    // ECS-006/ECS-002: a CLI run has no session, so no actor; the seeded target is in the payload.
    actor: EventDefinition.Actor.none,
    pii: [],
  },
);
export type AdminSeededEvent = typeof AdminSeededEvent.Type;

/** ECS-006: `awthaq seed admin` refused because an administrator already exists (and `--force` was not given). No address: the refusal names a reason, not a person. */
export const AdminSeedRefusedEvent = EventDefinition.define(
  "auth.admin.seedRefused",
  {
    reason: Schema.Literal("adminExists"),
  },
  {
    // ECS-006/ECS-002: a CLI run has no session, so no actor; the seeded target is in the payload.
    actor: EventDefinition.Actor.none,
    pii: [],
  },
);
export type AdminSeedRefusedEvent = typeof AdminSeedRefusedEvent.Type;

/** ECS-002: one `awthaq import --yes` run finished — every source row was imported, skipped or failed. */
export const ImportCompletedEvent = EventDefinition.define(
  "auth.import.completed",
  {
    source: Schema.String,
    runId: Schema.String,
    imported: Schema.Number,
    skipped: Schema.Number,
    failed: Schema.Number,
    unmapped: Schema.Number,
  },
  {
    // ECS-006/ECS-002: a CLI run has no session, so no actor; the seeded target is in the payload.
    actor: EventDefinition.Actor.none,
    pii: [],
  },
);
export type ImportCompletedEvent = typeof ImportCompletedEvent.Type;

/** ECS-002: one `awthaq import --yes` run stopped on a failed batch (counts are those reached so far). */
export const ImportFailedEvent = EventDefinition.define(
  "auth.import.failed",
  {
    source: Schema.String,
    runId: Schema.String,
    imported: Schema.Number,
    skipped: Schema.Number,
    failed: Schema.Number,
    unmapped: Schema.Number,
  },
  {
    // ECS-006/ECS-002: a CLI run has no session, so no actor; the seeded target is in the payload.
    actor: EventDefinition.Actor.none,
    pii: [],
  },
);
export type ImportFailedEvent = typeof ImportFailedEvent.Type;

/** Published by `@awthaq/organization`'s `create`. */
export const OrganizationCreatedEvent = EventDefinition.define(
  "auth.organization.created",
  {
    organizationId: Schema.String,
    creatorUserId: EventDefinition.UserId,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationCreatedEvent = typeof OrganizationCreatedEvent.Type;

/** Published by `@awthaq/organization`'s `update`. */
export const OrganizationUpdatedEvent = EventDefinition.define(
  "auth.organization.updated",
  {
    organizationId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationUpdatedEvent = typeof OrganizationUpdatedEvent.Type;

/** Published by `@awthaq/organization`'s `delete`. */
export const OrganizationDeletedEvent = EventDefinition.define(
  "auth.organization.deleted",
  {
    organizationId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationDeletedEvent = typeof OrganizationDeletedEvent.Type;

/** Published by `@awthaq/organization`'s `create` (the creator's own membership) and `addMember`. */
export const OrganizationMemberAddedEvent = EventDefinition.define(
  "auth.organization.memberAdded",
  {
    organizationId: Schema.String,
    userId: EventDefinition.UserId,
    role: RoleNames,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationMemberAddedEvent = typeof OrganizationMemberAddedEvent.Type;

/** Published by `@awthaq/organization`'s `removeMember`/`leave`. */
export const OrganizationMemberRemovedEvent = EventDefinition.define(
  "auth.organization.memberRemoved",
  {
    organizationId: Schema.String,
    userId: EventDefinition.UserId,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationMemberRemovedEvent = typeof OrganizationMemberRemovedEvent.Type;

/** Published by `@awthaq/organization`'s `updateMemberRole`. */
export const OrganizationMemberRoleUpdatedEvent = EventDefinition.define(
  "auth.organization.memberRoleUpdated",
  {
    organizationId: Schema.String,
    userId: EventDefinition.UserId,
    role: RoleNames,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationMemberRoleUpdatedEvent = typeof OrganizationMemberRoleUpdatedEvent.Type;

/**
 * Published by `@awthaq/organization`'s `invite`. ESA-005: identifiers only — the
 * invitee's email is *not* on the bus or in the audit row; a subscriber that needs
 * it resolves `invitationId` through the invitation record store, which the
 * erasure cascade owns.
 */
export const OrganizationInvitationCreatedEvent = EventDefinition.define(
  "auth.organization.invitationCreated",
  {
    invitationId: Schema.String,
    organizationId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationInvitationCreatedEvent = typeof OrganizationInvitationCreatedEvent.Type;

/** Published by `@awthaq/organization`'s `accept`. */
export const OrganizationInvitationAcceptedEvent = EventDefinition.define(
  "auth.organization.invitationAccepted",
  {
    invitationId: Schema.String,
    organizationId: Schema.String,
    userId: EventDefinition.UserId,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationInvitationAcceptedEvent = typeof OrganizationInvitationAcceptedEvent.Type;

/** Published by `@awthaq/organization`'s `reject`. */
export const OrganizationInvitationRejectedEvent = EventDefinition.define(
  "auth.organization.invitationRejected",
  {
    invitationId: Schema.String,
    organizationId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationInvitationRejectedEvent = typeof OrganizationInvitationRejectedEvent.Type;

/** Published by `@awthaq/organization`'s `cancel`. */
export const OrganizationInvitationCanceledEvent = EventDefinition.define(
  "auth.organization.invitationCanceled",
  {
    invitationId: Schema.String,
    organizationId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationInvitationCanceledEvent = typeof OrganizationInvitationCanceledEvent.Type;

/**
 * Published by `@awthaq/organization`'s invitation module when a pending invitation is found past its expiry
 * (an acceptance attempt after `expiresAt`); the invitation becomes `expired`. Identifiers only.
 */
export const OrganizationInvitationExpiredEvent = EventDefinition.define(
  "auth.organization.invitationExpired",
  {
    invitationId: Schema.String,
    organizationId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationInvitationExpiredEvent = typeof OrganizationInvitationExpiredEvent.Type;

/** Published by `@awthaq/organization`'s `createRole`. */
export const OrganizationRoleCreatedEvent = EventDefinition.define(
  "auth.organization.roleCreated",
  {
    organizationId: Schema.String,
    role: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationRoleCreatedEvent = typeof OrganizationRoleCreatedEvent.Type;

/** Published by `@awthaq/organization`'s `updateRole`. */
export const OrganizationRoleUpdatedEvent = EventDefinition.define(
  "auth.organization.roleUpdated",
  {
    organizationId: Schema.String,
    role: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationRoleUpdatedEvent = typeof OrganizationRoleUpdatedEvent.Type;

/** Published by `@awthaq/organization`'s `deleteRole`. */
export const OrganizationRoleDeletedEvent = EventDefinition.define(
  "auth.organization.roleDeleted",
  {
    organizationId: Schema.String,
    role: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationRoleDeletedEvent = typeof OrganizationRoleDeletedEvent.Type;

/**
 * `@awthaq/organization`'s per-organization OIDC/OAuth2 connection store, after each SUCCESSFUL mutation
 * (identifiers only; for an update the NAMES of the fields changed, never their values). `actorUserId` is the
 * user who acted when the actor names one (a member, a platform administrator); a directory or application
 * actor leaves it absent, so the audit row names no user.
 */
export const OrganizationConnectionCreatedEvent = EventDefinition.define(
  "auth.organization.connectionCreated",
  {
    organizationId: Schema.String,
    connectionId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationConnectionCreatedEvent = typeof OrganizationConnectionCreatedEvent.Type;

export const OrganizationConnectionUpdatedEvent = EventDefinition.define(
  "auth.organization.connectionUpdated",
  {
    organizationId: Schema.String,
    connectionId: Schema.String,
    fields: Schema.Array(Schema.String),
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationConnectionUpdatedEvent = typeof OrganizationConnectionUpdatedEvent.Type;

export const OrganizationConnectionDeletedEvent = EventDefinition.define(
  "auth.organization.connectionDeleted",
  {
    organizationId: Schema.String,
    connectionId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationConnectionDeletedEvent = typeof OrganizationConnectionDeletedEvent.Type;

/** Published by `@awthaq/organization`'s `createTeam`. */
export const OrganizationTeamCreatedEvent = EventDefinition.define(
  "auth.organization.teamCreated",
  {
    organizationId: Schema.String,
    teamId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationTeamCreatedEvent = typeof OrganizationTeamCreatedEvent.Type;

/** Published by `@awthaq/organization`'s `updateTeam`. */
export const OrganizationTeamUpdatedEvent = EventDefinition.define(
  "auth.organization.teamUpdated",
  {
    organizationId: Schema.String,
    teamId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationTeamUpdatedEvent = typeof OrganizationTeamUpdatedEvent.Type;

/** OHS-001: published by `@awthaq/organization`'s `moveTeam`; `parentId` is `null` when the team became a root. */
export const OrganizationTeamMovedEvent = EventDefinition.define(
  "auth.organization.teamMoved",
  {
    organizationId: Schema.String,
    teamId: Schema.String,
    parentId: Schema.NullOr(Schema.String),
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationTeamMovedEvent = typeof OrganizationTeamMovedEvent.Type;

/** Published by `@awthaq/organization`'s `removeTeam`. */
export const OrganizationTeamDeletedEvent = EventDefinition.define(
  "auth.organization.teamDeleted",
  {
    organizationId: Schema.String,
    teamId: Schema.String,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationTeamDeletedEvent = typeof OrganizationTeamDeletedEvent.Type;

/** Published by `@awthaq/organization`'s `addTeamMember` (and `acceptInvitation` for a team-targeted invitation). */
export const OrganizationTeamMemberAddedEvent = EventDefinition.define(
  "auth.organization.teamMemberAdded",
  {
    organizationId: Schema.String,
    teamId: Schema.String,
    userId: EventDefinition.UserId,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationTeamMemberAddedEvent = typeof OrganizationTeamMemberAddedEvent.Type;

/** OHS-004: published by `@awthaq/organization`'s `updateTeamMemberRole`. */
export const OrganizationTeamMemberRoleUpdatedEvent = EventDefinition.define(
  "auth.organization.teamMemberRoleUpdated",
  {
    organizationId: Schema.String,
    teamId: Schema.String,
    userId: EventDefinition.UserId,
    role: RoleNames,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationTeamMemberRoleUpdatedEvent =
  typeof OrganizationTeamMemberRoleUpdatedEvent.Type;

/** Published by `@awthaq/organization`'s `removeTeamMember`. */
export const OrganizationTeamMemberRemovedEvent = EventDefinition.define(
  "auth.organization.teamMemberRemoved",
  {
    organizationId: Schema.String,
    teamId: Schema.String,
    userId: EventDefinition.UserId,
    actorUserId: Schema.optional(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("actorUserId"),
    pii: [],
  },
);
export type OrganizationTeamMemberRemovedEvent = typeof OrganizationTeamMemberRemovedEvent.Type;

/**
 * Published by `@awthaq/organization` whenever its own `PermissionEngine`
 * gating denies an operation (PERS-005) — the plugin authorizes without a
 * qadi round trip, so without this its denials would leave no durable record.
 * `reason` says why: the caller is not a member (`notMember`, answered to the
 * caller as a 404) or is a member without the statement (`missingStatement`).
 */
export const OrganizationPermissionDeniedEvent = EventDefinition.define(
  "auth.organization.permissionDenied",
  {
    organizationId: Schema.String,
    userId: EventDefinition.UserId,
    resource: Schema.String,
    action: Schema.String,
    reason: Schema.Literals(["notMember", "missingStatement"]),
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
    attempt: true,
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
export const AuthorizationDeniedEvent = EventDefinition.define(
  "auth.authz.denied",
  {
    subjectId: Schema.String,
    evaluationId: Schema.String,
    policyTag: Schema.String,
    action: Schema.optional(Schema.String),
    reason: Schema.String,
  },
  {
    // qadi's own subject id: only a `user:` subject names an awthaq user.
    actor: EventDefinition.Actor.prefixed("subjectId", "user:"),
    pii: [],
    attempt: true,
  },
);
export type AuthorizationDeniedEvent = typeof AuthorizationDeniedEvent.Type;

/**
 * EOTS-007: published by a rate-limit budget (`RateLimits.budget`: `spend` or `guard`) on every rate-limit breach.
 * Deliberately carries no bucket key, email or IP (BEH-EA-108): it names the
 * rule that fired, so a defender can see which throttle is being hit and how
 * often without the event stream itself becoming an identifier oracle.
 */
export const RateLimitExceededEvent = EventDefinition.define(
  "auth.rateLimit.exceeded",
  {
    group: Schema.String,
    endpoint: Schema.String,
    rule: Schema.String,
    dimension: Schema.Literals(["identity", "ip", "principal", "custom"]),
    retryAfterMillis: Schema.Number,
  },
  {
    actor: EventDefinition.Actor.none,
    pii: [],
    attempt: true,
  },
);
export type RateLimitExceededEvent = typeof RateLimitExceededEvent.Type;

/**
 * ERS-002: published by `MailDispatch` when a mail that was accepted for
 * background delivery could not be delivered after its retries (or failed
 * permanently) — the one signal that a verification/reset mail was lost,
 * since the request that triggered it already answered uniformly. Carries the
 * template and, when known, the user it concerned, never the recipient
 * address or any token (EOTS-010).
 */
export const MailFailedEvent = EventDefinition.define(
  "auth.mail.failed",
  {
    template: Schema.String,
    userId: Schema.optionalKey(EventDefinition.UserId),
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type MailFailedEvent = typeof MailFailedEvent.Type;

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
export const TwoFactorEnabledEvent = EventDefinition.define(
  "auth.twoFactor.enabled",
  {
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type TwoFactorEnabledEvent = typeof TwoFactorEnabledEvent.Type;

/** Published when the factor is removed (secret and recovery codes deleted). */
export const TwoFactorDisabledEvent = EventDefinition.define(
  "auth.twoFactor.disabled",
  {
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type TwoFactorDisabledEvent = typeof TwoFactorDisabledEvent.Type;

/** Published on every successful presentation of a second factor, with the method used. */
export const TwoFactorVerifiedEvent = EventDefinition.define(
  "auth.twoFactor.verified",
  {
    userId: EventDefinition.UserId,
    method: TwoFactorMethod,
    purpose: TwoFactorPurpose,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type TwoFactorVerifiedEvent = typeof TwoFactorVerifiedEvent.Type;

/** Published on every failed presentation (wrong code, replayed step, unknown recovery code). */
export const TwoFactorChallengeFailedEvent = EventDefinition.define(
  "auth.twoFactor.challengeFailed",
  {
    userId: EventDefinition.UserId,
    method: TwoFactorMethod,
    purpose: TwoFactorPurpose,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
    attempt: true,
  },
);
export type TwoFactorChallengeFailedEvent = typeof TwoFactorChallengeFailedEvent.Type;

/** Published when a recovery code is spent; `remaining` is what is left, for a low-supply warning. */
export const TwoFactorRecoveryCodeUsedEvent = EventDefinition.define(
  "auth.twoFactor.recoveryCodeUsed",
  {
    userId: EventDefinition.UserId,
    remaining: Schema.Number,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type TwoFactorRecoveryCodeUsedEvent = typeof TwoFactorRecoveryCodeUsedEvent.Type;

/** Published when the recovery codes are replaced by a fresh set (the old set is invalid). */
export const TwoFactorRecoveryCodesRegeneratedEvent = EventDefinition.define(
  "auth.twoFactor.recoveryCodesRegenerated",
  { userId: EventDefinition.UserId },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type TwoFactorRecoveryCodesRegeneratedEvent =
  typeof TwoFactorRecoveryCodesRegeneratedEvent.Type;

/** BCR-006: the shared per-account failure budget was exhausted; the second factor is locked for the window. */
export const TwoFactorLockedEvent = EventDefinition.define(
  "auth.twoFactor.locked",
  {
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
    attempt: true,
  },
);
export type TwoFactorLockedEvent = typeof TwoFactorLockedEvent.Type;

/** BEH-EA-101, ADR-EA-049: core's own event definitions. A composition adds every composed plugin's (`Auth.make`). */
export const CoreRegistry = EventDefinition.make(
  [
    TokenReplayEvent,
    UserCreatedEvent,
    AccountLinkedEvent,
    UserSignedInEvent,
    UserSignInFailedEvent,
    UserDeletedEvent,
    UserDataExportedEvent,
    SessionReuseEvent,
    SessionIssuedEvent,
    SessionRotatedEvent,
    SessionSupersededEvent,
    SessionRevokedEvent,
    SessionExpiredEvent,
    PasswordChangedEvent,
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
    WebhookEndpointCreatedEvent,
    WebhookEndpointUpdatedEvent,
    WebhookSecretRotatedEvent,
    WebhookEndpointDeletedEvent,
    WebhookTestQueuedEvent,
    SamlConnectionCreatedEvent,
    OrganizationConnectionCreatedEvent,
    OrganizationConnectionUpdatedEvent,
    OrganizationConnectionDeletedEvent,
    SamlConnectionUpdatedEvent,
    SamlConnectionDeletedEvent,
    SamlSigningKeyRotatedEvent,
    SamlLogoutRejectedEvent,
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
    OrganizationInvitationExpiredEvent,
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
    RateLimitExceededEvent,
    MailFailedEvent,
    TwoFactorEnabledEvent,
    TwoFactorDisabledEvent,
    TwoFactorVerifiedEvent,
    TwoFactorChallengeFailedEvent,
    TwoFactorRecoveryCodeUsedEvent,
    TwoFactorRecoveryCodesRegeneratedEvent,
    TwoFactorLockedEvent,
  ],
  "core",
);

/** Core's definitions, the start of every composition's set (`Auth.make` refuses a plugin redeclaring one). */
export const coreDefinitions = CoreRegistry.definitions;
/** BEH-EA-101: the closed, statically-known set of core's event types. */
export const AuthEventSchema = CoreRegistry.schema;
/** Every tag core defines. */
export const eventTags = CoreRegistry.tags;
/** True for a string that is a core tag (narrows it to `AuthEventTag`). */
export const isEventTag = CoreRegistry.isTag;
/** Who acted, as the raw id the audit row's actor column records (`Option.none()` when no user acted). */
export const actorOf = CoreRegistry.actorOf;
/** ADR-EA-029: the fields of core's `tag` that hold free text about a person. */
export const piiFieldsOf = CoreRegistry.piiFieldsOf;
/** ADR-EA-037: true for core's attempt events, which are recorded and delivered whether or not their unit of work commits. */
export const isAttemptEvent = CoreRegistry.isAttempt;

/** Any event core may hold without knowing its shape: any registered or stored event. */
export type AnyEvent = EventDefinition.AnyEvent;

/**
 * ADR-EA-049: the composition's event registry, core's definitions plus every composed plugin's
 * (`auth.eventsLayer` provides it, `TestAuth.layer` and `AuthHost.layer` do so for you). Core's own set
 * by default. Read by the readers of "every tag": webhook filters and payloads, Retention rules.
 */
export const EventRegistry = Context.Reference<EventDefinition.Registry<AnyEvent>>(
  "awthaq/core/EventRegistry",
  { defaultValue: () => CoreRegistry },
);

/** ADR-EA-049: the tag of a `ForeignEvent`; reserved, so no definition may use it (`EventDefinition.problems`, `Auth.make`). */
export const ForeignEventTag = EventDefinition.ForeignEventTag;

/**
 * ADR-EA-049: a stored event whose tag core does not define, a plugin's (still composed or removed), as
 * `AuditLog` reads it. Core decodes nothing of it; the plugin decodes its own rows with
 * `AuditLog.payloadAs(definition)`. The fixed literal tag keeps `AuthEvent | ForeignEvent` narrowable.
 */
export const ForeignEvent = Schema.TaggedStruct(ForeignEventTag, {
  /** The stored tag (`AuditLogRecord.eventTag`). */
  tag: Schema.String,
  /** The event's stored fields, without `_tag`, `version` and `meta`. */
  fields: Schema.Record(Schema.String, Schema.Unknown),
});
export type ForeignEvent = typeof ForeignEvent.Type;

/** Provides `EventRegistry`; `Auth.make` returns one for its composed set as `eventsLayer`. */
export const eventRegistryLayer = (registry: EventDefinition.Registry<AnyEvent>) =>
  Layer.succeed(EventRegistry, registry);

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
 * `tenantId` is the ambient `TenantContext` at the publish site (ADR-EA-018): the same value the audit row's
 * `"tenantId"` column stores (BEH-EA-231), carried on the envelope so a tenant-aware consumer
 * (`@awthaq/webhooks`' per-tenant endpoints) routes without a second lookup. `None` outside a tenant scope.
 */
export interface EventMetadata {
  readonly eventId: string;
  readonly occurredAt: DateTime.Utc;
  readonly correlationId: Option.Option<string>;
  readonly traceId: Option.Option<string>;
  readonly spanId: Option.Option<string>;
  readonly ip: Option.Option<string>;
  readonly userAgent: Option.Option<string>;
  readonly tenantId: Option.Option<string>;
}

/** A delivered event: the payload plus its envelope. An intersection distributes over the union, so `_tag` narrowing still works. */
export type Published<E extends AnyEvent = AuthEvent> = E & EventMetadata;

/** ADR-EA-049: any delivered event, core's or a plugin's, unnarrowed. Narrow it with `AuthEvents.is(...)`. */
export type PublishedAny = Published<AnyEvent>;

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
