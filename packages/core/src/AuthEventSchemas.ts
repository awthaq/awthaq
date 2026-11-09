// @awthaq/core — AuthEventSchemas
//
// spec/behaviors/13-events.md, BEH-EA-101, ADR-EA-049: core's own event
// definitions. A composition's closed set of event types is these plus every
// composed plugin's declared `events` (`Auth.make`); each plugin defines the
// events it publishes in its own package (`<Plugin>Events.ts`). Core keeps the
// events core publishes, those several packages publish, those core reads by
// tag, the CLI's, and `auth.authz.denied` (§3.8 of architecture plan 29).
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
// through the record store, which the erasure cascade owns. An event that must
// carry free text about a person declares it with the event
// (`EventDefinition.define`'s `pii`), so erasure can scrub it and the webhooks
// payload never sends it. None of core's events declares any.
//
// Every core event is declared with `EventDefinition.define(tag, fields, { actor, pii, attempt? })`
// (`EventDefinition.ts`), the same call a plugin uses: its shape, who acted
// (the audit row's actor column), which fields hold free text about a person,
// and whether it records an attempt. `EventDefinition.make([...])` refuses a
// member whose declaration does not check against its own fields.

import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as EventDefinition from "./EventDefinition.ts";

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
    AdminImpersonationDeniedEvent,
    AdminActionDeniedEvent,
    AdminSeededEvent,
    AdminSeedRefusedEvent,
    ImportCompletedEvent,
    ImportFailedEvent,
    AuthorizationDeniedEvent,
    RateLimitExceededEvent,
    MailFailedEvent,
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
