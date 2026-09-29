// @awthaq/core — AuthEvents
//
// spec/behaviors/13-events.md, BEH-EA-097 through BEH-EA-104.
//
// The registry (BEH-EA-101) starts with exactly the tags this module and its
// callers actually publish, not the full illustrative set
// `spec/behaviors/13-events.md`'s own examples name (`auth.user.signedIn`,
// `auth.session.issued`, ...) — a tag nothing publishes yet would be
// speculative surface with no test to hold it accountable. BEH-EA-101 itself
// frames the registry as something "a plugin author can add a new event tag"
// to; growing it as real publishers appear (`Verification.ts`'s
// `auth.token.replay`, `@awthaq/password`'s `auth.user.created`/
// `auth.user.signedIn`) is that same growth, not a narrowing of the design.

import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { AuditLog } from "./AuditLog.ts";
import type { UserId } from "./Users.ts";

/** BEH-EA-059: published whenever `Verification.consume` fails — expired, unknown, or already-consumed alike (the same uniform-response reasoning as `TokenConsumed` itself). */
export interface TokenReplayEvent {
  readonly _tag: "auth.token.replay";
  readonly identifier: string;
}

/** Published by `@awthaq/password`'s `signUp`. */
export interface UserCreatedEvent {
  readonly _tag: "auth.user.created";
  readonly userId: UserId;
}

/** Published by `@awthaq/password`'s `signIn`. */
export interface UserSignedInEvent {
  readonly _tag: "auth.user.signedIn";
  readonly userId: UserId;
  readonly strategy: string;
}

/**
 * ALF-003: published by `@awthaq/password`'s `signIn` on every failure
 * path — the wire response's uniform-response discipline (BEH-EA-116,
 * hides which of the underlying reasons applied from the caller) is
 * deliberately NOT extended to this audit channel: the whole point of
 * this event is to make brute-force/credential-stuffing attempts visible
 * to a defender, which requires the distinction the wire response hides.
 * No `userId` and no email: a nonexistent-account attempt has no `userId`
 * to carry, and a *present* `userId` would itself leak account existence
 * through the event's own shape — the same oracle the wire response's
 * uniform response exists to close, just relocated to whoever is
 * subscribed to this stream instead of to the caller.
 */
export interface UserSignInFailedEvent {
  readonly _tag: "auth.user.signInFailed";
  readonly strategy: string;
  // SCP-001: `suspended` — the credential was right but `Users.assertCanSignIn` refused.
  readonly reason: "invalidCredentials" | "emailNotVerified" | "suspended";
}

/**
 * RRS-003: published by `Sessions.verify` the first time a tombstoned
 * (already-superseded) session token is presented again — refresh-token
 * reuse, the standard signal a token family has been compromised. Every
 * still-live row sharing `familyId` is revoked in the same call.
 */
export interface SessionReuseEvent {
  readonly _tag: "auth.session.reuse";
  readonly sessionId: string;
  readonly familyId: string;
  readonly userId: UserId;
}

/**
 * ALF-004/ESA-006: published by `Sessions.issue` itself (both layers), so
 * every path that mints a session — password, OAuth, passkey, admin
 * impersonation, a legacy-session bridge, a `supersedes` rotation — emits
 * exactly one, with no plugin having to remember to.
 */
export interface SessionIssuedEvent {
  readonly _tag: "auth.session.issued";
  readonly sessionId: string;
  readonly userId: UserId;
  /** RRS-003: the rotation family this session belongs to (its own id for a fresh family). */
  readonly familyId: string;
  /** BEH-EA-209: present only for an impersonation session. */
  readonly actingAs?: { readonly type: string; readonly id: string };
}

/** TIR-008/ESA-006: why a session ended — supplied by the caller of every `Sessions` revocation primitive. */
export type SessionRevocationReason =
  | "signOut"
  | "userRevoked"
  | "passwordChanged"
  | "passwordReset"
  | "userDeleted"
  | "impersonationStopped"
  | "admin"
  /** SCP-001/BAM-005: every session of a user ended because the account was suspended/banned. */
  | "suspended"
  | "reuseDetected"
  /** SMS-003: evicted by `SessionConfig.maxConcurrent` when the user's newest session was issued. */
  | "limitEvicted";

/**
 * TIR-008/ESA-006: published by `Sessions`' own revocation primitives
 * (`revoke`, `revokeOwned`, `revokeOthers`, `revokeAll`, and reuse-detection's
 * family revocation), so every revocation path is observable and lands in
 * `AuditLog` — sign-out, account deletion and admin stops included, not just
 * the password plugin's bulk revocations. `sessionId` is the ended row for
 * `scope: "one"` and `null` for a bulk scope, which has no single row to name.
 */
export interface SessionRevokedEvent {
  readonly _tag: "auth.session.revoked";
  readonly userId: UserId;
  readonly sessionId: string | null;
  readonly scope: "one" | "others" | "all" | "family";
  readonly reason: SessionRevocationReason;
}

/**
 * ESA-006: published when `Sessions.verify` observes that a presented session
 * (with its correct secret) is past its absolute or idle expiry. Lazy: there
 * is no background reaper (CSG-003), so an expiry is only observed when the
 * expired credential is presented, and each such presentation publishes one.
 */
export interface SessionExpiredEvent {
  readonly _tag: "auth.session.expired";
  readonly sessionId: string;
  readonly userId: UserId;
  readonly kind: "absolute" | "idle";
}

/** ALF-004: published by `@awthaq/password`'s `changePassword`, after the new hash is persisted. */
export interface PasswordChangedEvent {
  readonly _tag: "auth.password.changed";
  readonly userId: UserId;
}

/** ALF-004: published by `@awthaq/password`'s `confirmReset`, once the transaction (consume + rehash + revoke) has committed. */
export interface PasswordResetCompletedEvent {
  readonly _tag: "auth.password.resetCompleted";
  readonly userId: UserId;
}

/**
 * Published by `@awthaq/passkey`'s authentication ceremony (BEH-EA-131,
 * ticket 08): a verified assertion's reported counter did not exceed the
 * stored one — "log + step-up, not an instant kill" per that ticket's own
 * language, so the session still issues and this event is the whole
 * response to the anomaly, not a request-level failure.
 */
export interface PasskeyCounterAnomalyEvent {
  readonly _tag: "auth.passkey.counterAnomaly";
  readonly userId: UserId;
  readonly credentialId: string;
}

/** Published by `@awthaq/admin`'s `impersonate`, on success (BEH-EA-218). */
export interface AdminImpersonationStartedEvent {
  readonly _tag: "auth.admin.impersonationStarted";
  readonly adminUserId: UserId;
  readonly targetUserId: UserId;
  readonly reason: string;
  readonly sessionId: string;
}

/** Published by `@awthaq/admin`'s `stopImpersonating`/`forceStop` (BEH-EA-218). */
export interface AdminImpersonationStoppedEvent {
  readonly _tag: "auth.admin.impersonationStopped";
  readonly sessionId: string;
  readonly endedBy: "self" | "forcedByAdmin" | "expired";
}

/**
 * Published by `@awthaq/admin`'s `impersonate`/`forceStop`/`list`, but
 * only for a genuine `AdminConfig.canImpersonate` rejection — never for
 * self-impersonation, nested-impersonation, or an unknown target/session,
 * which are ordinary validation failures (BEH-EA-218's own "not diluted with
 * input-error noise" reasoning).
 */
export interface AdminImpersonationDeniedEvent {
  readonly _tag: "auth.admin.impersonationDenied";
  readonly adminUserId: UserId;
}

/**
 * BAM-005: published by `@awthaq/admin` when an admin capability other than
 * impersonation (`AdminConfig.canManageUsers`) resolves `false` — the same
 * "genuine authorization rejection, never input-validation noise" signal
 * `auth.admin.impersonationDenied` is for impersonation. `action` names the
 * endpoint (`"listUsers"`, `"updateUser"`, ...).
 */
export interface AdminActionDeniedEvent {
  readonly _tag: "auth.admin.actionDenied";
  readonly adminUserId: UserId;
  readonly action: string;
}

/** BAM-005: published by `@awthaq/admin`'s `updateUser`, after the profile change is persisted. */
export interface AdminUserUpdatedEvent {
  readonly _tag: "auth.admin.userUpdated";
  readonly adminUserId: UserId;
  readonly userId: UserId;
}

/**
 * BAM-005/SCP-001: published by `@awthaq/admin`'s `banUser`, after `Users.setStatus("suspended")`
 * and `Sessions.revokeAll(userId, "suspended")` both completed. `reason`/`until` are the
 * operator's note and the optional expiry (ISO instant), `null` when not given.
 */
export interface AdminUserBannedEvent {
  readonly _tag: "auth.admin.userBanned";
  readonly adminUserId: UserId;
  readonly userId: UserId;
  readonly reason: string | null;
  readonly until: string | null;
}

/** BAM-005: published by `@awthaq/admin`'s `unbanUser`, after `Users.setStatus("active")`. */
export interface AdminUserUnbannedEvent {
  readonly _tag: "auth.admin.userUnbanned";
  readonly adminUserId: UserId;
  readonly userId: UserId;
}

/**
 * BAM-005: published by `@awthaq/admin`'s `revokeUserSession`/`revokeUserSessions`.
 * `sessionId` is the one revoked session, or `null` when every non-impersonation
 * session of `userId` was revoked in one call.
 */
export interface AdminSessionRevokedEvent {
  readonly _tag: "auth.admin.sessionRevoked";
  readonly adminUserId: UserId;
  readonly userId: UserId;
  readonly sessionId: string | null;
}

/** Published by `@awthaq/organization`'s `create`. */
export interface OrganizationCreatedEvent {
  readonly _tag: "auth.organization.created";
  readonly organizationId: string;
  readonly creatorUserId: UserId;
}

/** Published by `@awthaq/organization`'s `update`. */
export interface OrganizationUpdatedEvent {
  readonly _tag: "auth.organization.updated";
  readonly organizationId: string;
}

/** Published by `@awthaq/organization`'s `delete`. */
export interface OrganizationDeletedEvent {
  readonly _tag: "auth.organization.deleted";
  readonly organizationId: string;
}

/** Published by `@awthaq/organization`'s `create` (the creator's own membership) and `addMember`. */
export interface OrganizationMemberAddedEvent {
  readonly _tag: "auth.organization.memberAdded";
  readonly organizationId: string;
  readonly userId: UserId;
  readonly role: ReadonlyArray<string>;
}

/** Published by `@awthaq/organization`'s `removeMember`/`leave`. */
export interface OrganizationMemberRemovedEvent {
  readonly _tag: "auth.organization.memberRemoved";
  readonly organizationId: string;
  readonly userId: UserId;
}

/** Published by `@awthaq/organization`'s `updateMemberRole`. */
export interface OrganizationMemberRoleUpdatedEvent {
  readonly _tag: "auth.organization.memberRoleUpdated";
  readonly organizationId: string;
  readonly userId: UserId;
  readonly role: ReadonlyArray<string>;
}

/** Published by `@awthaq/organization`'s `invite`. */
export interface OrganizationInvitationCreatedEvent {
  readonly _tag: "auth.organization.invitationCreated";
  readonly invitationId: string;
  readonly organizationId: string;
  readonly email: string;
}

/** Published by `@awthaq/organization`'s `accept`. */
export interface OrganizationInvitationAcceptedEvent {
  readonly _tag: "auth.organization.invitationAccepted";
  readonly invitationId: string;
  readonly organizationId: string;
  readonly userId: UserId;
}

/** Published by `@awthaq/organization`'s `reject`. */
export interface OrganizationInvitationRejectedEvent {
  readonly _tag: "auth.organization.invitationRejected";
  readonly invitationId: string;
  readonly organizationId: string;
}

/** Published by `@awthaq/organization`'s `cancel`. */
export interface OrganizationInvitationCanceledEvent {
  readonly _tag: "auth.organization.invitationCanceled";
  readonly invitationId: string;
  readonly organizationId: string;
}

/** Published by `@awthaq/organization`'s `createRole`. */
export interface OrganizationRoleCreatedEvent {
  readonly _tag: "auth.organization.roleCreated";
  readonly organizationId: string;
  readonly role: string;
}

/** Published by `@awthaq/organization`'s `updateRole`. */
export interface OrganizationRoleUpdatedEvent {
  readonly _tag: "auth.organization.roleUpdated";
  readonly organizationId: string;
  readonly role: string;
}

/** Published by `@awthaq/organization`'s `deleteRole`. */
export interface OrganizationRoleDeletedEvent {
  readonly _tag: "auth.organization.roleDeleted";
  readonly organizationId: string;
  readonly role: string;
}

/** Published by `@awthaq/organization`'s `createTeam`. */
export interface OrganizationTeamCreatedEvent {
  readonly _tag: "auth.organization.teamCreated";
  readonly organizationId: string;
  readonly teamId: string;
}

/** Published by `@awthaq/organization`'s `updateTeam`. */
export interface OrganizationTeamUpdatedEvent {
  readonly _tag: "auth.organization.teamUpdated";
  readonly organizationId: string;
  readonly teamId: string;
}

/** OHS-001: published by `@awthaq/organization`'s `moveTeam`; `parentId` is `null` when the team became a root. */
export interface OrganizationTeamMovedEvent {
  readonly _tag: "auth.organization.teamMoved";
  readonly organizationId: string;
  readonly teamId: string;
  readonly parentId: string | null;
}

/** Published by `@awthaq/organization`'s `removeTeam`. */
export interface OrganizationTeamDeletedEvent {
  readonly _tag: "auth.organization.teamDeleted";
  readonly organizationId: string;
  readonly teamId: string;
}

/** Published by `@awthaq/organization`'s `addTeamMember` (and `acceptInvitation` for a team-targeted invitation). */
export interface OrganizationTeamMemberAddedEvent {
  readonly _tag: "auth.organization.teamMemberAdded";
  readonly organizationId: string;
  readonly teamId: string;
  readonly userId: UserId;
}

/** OHS-004: published by `@awthaq/organization`'s `updateTeamMemberRole`. */
export interface OrganizationTeamMemberRoleUpdatedEvent {
  readonly _tag: "auth.organization.teamMemberRoleUpdated";
  readonly organizationId: string;
  readonly teamId: string;
  readonly userId: UserId;
  readonly role: ReadonlyArray<string>;
}

/** Published by `@awthaq/organization`'s `removeTeamMember`. */
export interface OrganizationTeamMemberRemovedEvent {
  readonly _tag: "auth.organization.teamMemberRemoved";
  readonly organizationId: string;
  readonly teamId: string;
  readonly userId: UserId;
}

/**
 * Published by `@awthaq/organization` whenever its own `PermissionEngine`
 * gating denies an operation (PERS-005) — the plugin authorizes without a
 * qadi round trip, so without this its denials would leave no durable record.
 * `reason` says why: the caller is not a member (`notMember`, answered to the
 * caller as a 404) or is a member without the statement (`missingStatement`).
 */
export interface OrganizationPermissionDeniedEvent {
  readonly _tag: "auth.organization.permissionDenied";
  readonly organizationId: string;
  readonly userId: UserId;
  readonly resource: string;
  readonly action: string;
  readonly reason: "notMember" | "missingStatement";
}

/**
 * Published by `@awthaq/qadi`'s `DecisionSinkAudit` for every authorization
 * denial qadi's evaluator reaches (TS-003) — which policy denied which
 * subject, durably, without the operator writing a sink of their own.
 * `subjectId` is qadi's own subject id (`user:<id>`, `apikey:<id>`,
 * `anonymous`, ...); `reason` is qadi's denial sentence (it names attributes,
 * never their values).
 */
export interface AuthorizationDeniedEvent {
  readonly _tag: "auth.authz.denied";
  readonly subjectId: string;
  readonly evaluationId: string;
  readonly policyTag: string;
  readonly action?: string | undefined;
  readonly reason: string;
}

/**
 * Published by `@awthaq/roles`' `assign`/`revoke` on a *real* change of a
 * user's global role assignments (RRM-005): a re-assign or a revoke of a role
 * the user never held publishes nothing. `userId` is the user whose roles
 * changed; `actorUserId` the operator who changed them, when the caller said —
 * `Roles` is a trusted primitive, so an application-driven change has none.
 */
export interface RolesAssignedEvent {
  readonly _tag: "auth.roles.assigned";
  readonly userId: UserId;
  readonly roleName: string;
  readonly actorUserId?: UserId | undefined;
}

/**
 * FAMS-004: published by `@awthaq/qadi`'s `UserClaims` on a real change. `keys` names the
 * claim keys that changed — never their values, which may be sensitive and must not enter the
 * audit trail; `actorUserId` is who made the change, when known.
 */
export interface UserClaimsUpdatedEvent {
  readonly _tag: "auth.user.claimsUpdated";
  readonly userId: UserId;
  readonly keys: ReadonlyArray<string>;
  readonly actorUserId?: UserId | undefined;
}

export interface RolesRevokedEvent {
  readonly _tag: "auth.roles.revoked";
  readonly userId: UserId;
  readonly roleName: string;
  readonly actorUserId?: UserId | undefined;
}

/**
 * EOTS-007: published by `RateLimits.enforce` on every rate-limit breach.
 * Deliberately carries no bucket key, email or IP (BEH-EA-108): it names the
 * rule that fired, so a defender can see which throttle is being hit and how
 * often without the event stream itself becoming an identifier oracle.
 */
export interface RateLimitExceededEvent {
  readonly _tag: "auth.rateLimit.exceeded";
  readonly group: string;
  readonly endpoint: string;
  readonly rule: string;
  readonly dimension: "identity" | "ip" | "principal" | "custom";
  readonly retryAfterMillis: number;
}

/**
 * ERS-002: published by `MailDispatch` when a mail that was accepted for
 * background delivery could not be delivered after its retries (or failed
 * permanently) — the one signal that a verification/reset mail was lost,
 * since the request that triggered it already answered uniformly. Carries the
 * template and, when known, the user it concerned, never the recipient
 * address or any token (EOTS-010).
 */
export interface MailFailedEvent {
  readonly _tag: "auth.mail.failed";
  readonly template: string;
  readonly userId?: UserId;
}

/**
 * OCM-002/OCM-005 (`@awthaq/api-key`): the lifecycle of a long-lived API key and of a
 * `client_credentials` client. `userId` is the owner who acted; `keyId`/`clientId`
 * are the public ids (never a secret or a hash). `rotated` names the predecessor
 * (`keyId`) and its successor.
 */
export interface ApiKeyCreatedEvent {
  readonly _tag: "auth.apiKey.created";
  readonly userId: UserId;
  readonly keyId: string;
}

export interface ApiKeyRevokedEvent {
  readonly _tag: "auth.apiKey.revoked";
  readonly userId: UserId;
  readonly keyId: string;
}

export interface ApiKeyRotatedEvent {
  readonly _tag: "auth.apiKey.rotated";
  readonly userId: UserId;
  readonly keyId: string;
  readonly successorKeyId: string;
}

export interface ApiKeyClientRegisteredEvent {
  readonly _tag: "auth.apiKey.clientRegistered";
  readonly userId: UserId;
  readonly clientId: string;
}

export interface ApiKeyClientRevokedEvent {
  readonly _tag: "auth.apiKey.clientRevoked";
  readonly userId: UserId;
  readonly clientId: string;
}

export interface ApiKeyClientSecretRotatedEvent {
  readonly _tag: "auth.apiKey.clientSecretRotated";
  readonly userId: UserId;
  readonly clientId: string;
}

/** BEH-EA-101: the closed, statically-known set of event types `AuthEvents` carries today. */
export type AuthEvent =
  | TokenReplayEvent
  | UserCreatedEvent
  | UserSignedInEvent
  | UserSignInFailedEvent
  | SessionReuseEvent
  | SessionIssuedEvent
  | SessionRevokedEvent
  | SessionExpiredEvent
  | PasswordChangedEvent
  | PasswordResetCompletedEvent
  | PasskeyCounterAnomalyEvent
  | AdminImpersonationStartedEvent
  | AdminImpersonationStoppedEvent
  | AdminImpersonationDeniedEvent
  | AdminActionDeniedEvent
  | AdminUserUpdatedEvent
  | AdminUserBannedEvent
  | AdminUserUnbannedEvent
  | AdminSessionRevokedEvent
  | OrganizationCreatedEvent
  | OrganizationUpdatedEvent
  | OrganizationDeletedEvent
  | OrganizationMemberAddedEvent
  | OrganizationMemberRemovedEvent
  | OrganizationMemberRoleUpdatedEvent
  | OrganizationInvitationCreatedEvent
  | OrganizationInvitationAcceptedEvent
  | OrganizationInvitationRejectedEvent
  | OrganizationInvitationCanceledEvent
  | OrganizationRoleCreatedEvent
  | OrganizationRoleUpdatedEvent
  | OrganizationRoleDeletedEvent
  | OrganizationTeamCreatedEvent
  | OrganizationTeamUpdatedEvent
  | OrganizationTeamMovedEvent
  | OrganizationTeamDeletedEvent
  | OrganizationTeamMemberAddedEvent
  | OrganizationTeamMemberRoleUpdatedEvent
  | OrganizationTeamMemberRemovedEvent
  | OrganizationPermissionDeniedEvent
  | AuthorizationDeniedEvent
  | RolesAssignedEvent
  | UserClaimsUpdatedEvent
  | RolesRevokedEvent
  | RateLimitExceededEvent
  | MailFailedEvent
  | ApiKeyCreatedEvent
  | ApiKeyRevokedEvent
  | ApiKeyRotatedEvent
  | ApiKeyClientRegisteredEvent
  | ApiKeyClientRevokedEvent
  | ApiKeyClientSecretRotatedEvent;

export interface AuthEventsShape {
  /** BEH-EA-098: returns once the event is enqueued — never suspends on a subscriber. */
  readonly publish: (event: AuthEvent) => Effect.Effect<void>;
  /** BEH-EA-102: raw stream access for a consumer that needs custom filtering/multiplexing. */
  readonly stream: Stream.Stream<AuthEvent>;
  /**
   * ALF-002/ESS-001/TMS-002/TRBS-003: how many `publish` calls have been
   * silently dropped (the bus was at capacity) since this `AuthEvents`
   * instance was built — the observable cost of `publish` never
   * suspending, so loss is visible rather than merely possible.
   */
  readonly droppedCount: Effect.Effect<number>;
}

export class AuthEvents extends Context.Service<AuthEvents, AuthEventsShape>()(
  "awthaq/core/AuthEvents",
) {}

/**
 * BEH-EA-097: a bounded capacity, so a slow or absent subscriber cannot
 * cause unbounded memory growth in the publishing process. No spec'd number
 * exists for this — 1024 is chosen as a generous, arbitrary default; an
 * application with a genuinely different tolerance can still swap this
 * `Layer` entirely, the same way any other capability is swapped.
 */
export const CAPACITY = 1024;

/**
 * BEH-EA-100: `AuditLog` is a hard dependency — `publish` writes the
 * durable row inline, before the event ever reaches the `PubSub`. This is
 * what actually satisfies "MUST NOT depend on any `AuthEvents` subscriber":
 * durability lives structurally inside `publish` itself, not in something
 * optional a caller composes alongside it.
 */
export const layer: Layer.Layer<AuthEvents, never, AuditLog> = Layer.effect(
  AuthEvents,
  Effect.gen(function* () {
    const auditLog = yield* AuditLog;
    // ALF-002/ESS-001/TMS-002/TRBS-003: `PubSub.bounded` applies
    // backpressure — its own publish suspends the calling fiber once the
    // buffer is full, directly contradicting this shape's own "never
    // suspends on a subscriber" contract (BEH-EA-098) and coupling the
    // auth hot path (every one of Password.signIn/signUp,
    // Verification.consume's replay/failure paths, OAuth's callback, …
    // publishes inline) to whatever subscriber happens to be installed —
    // a lagging or entirely absent one turns into a denial of service on
    // sign-in itself. `PubSub.dropping` keeps the identical bounded-memory
    // guarantee (BEH-EA-097) but never suspends the publisher: a full
    // buffer drops the newest event instead, which `droppedCount` below
    // makes observable rather than silent.
    const pubsub = yield* PubSub.dropping<AuthEvent>(CAPACITY);
    const dropped = yield* Ref.make(0);
    const publish: AuthEventsShape["publish"] = (event) =>
      Effect.gen(function* () {
        yield* auditLog.record(event);
        const accepted = yield* PubSub.publish(pubsub, event);
        if (!accepted) {
          yield* Ref.update(dropped, (n) => n + 1);
          yield* Effect.logWarning(
            `awthaq: AuthEvents dropped a "${event._tag}" event — subscriber(s) not keeping up`,
          );
        }
      });
    return AuthEvents.of({
      publish,
      stream: Stream.fromPubSub(pubsub),
      droppedCount: Ref.get(dropped),
    });
  }),
);

/**
 * BEH-EA-103: sugar producing a subscription `Layer` — a caller never writes
 * its own `Stream.runForEach`/`Effect.forkScoped` to get BEH-EA-099's
 * isolation. `Layer.effectDiscard` is what supplies and then strips the
 * `Scope.Scope` the forked fiber needs (its own doc: "Exclude<R, Scope.Scope>"),
 * so the subscription's lifetime is exactly this `Layer`'s own.
 */
export const on = <Tag extends AuthEvent["_tag"]>(
  tag: Tag,
  handler: (event: Extract<AuthEvent, { readonly _tag: Tag }>) => Effect.Effect<void, unknown>,
): Layer.Layer<never, never, AuthEvents> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const events = yield* AuthEvents;
      yield* events.stream.pipe(
        Stream.filter((event): event is Extract<AuthEvent, { readonly _tag: Tag }> =>
          Object.is(event._tag, tag),
        ),
        // BEH-EA-099/104: a failing handler is logged under a stable name and
        // never propagates — to the publisher, to another subscriber's
        // fiber, or anywhere else.
        Stream.runForEach((event) =>
          handler(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("auth.event.observer.error", { tag, cause }),
            ),
          ),
        ),
        Effect.forkScoped,
      );
    }),
  );
