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
  readonly reason: "invalidCredentials" | "emailNotVerified";
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

/** ALF-004: published whenever `@awthaq/password` mints a session — signUp's initial session, signIn, and changePassword's own rotation alike. */
export interface SessionIssuedEvent {
  readonly _tag: "auth.session.issued";
  readonly sessionId: string;
  readonly userId: UserId;
}

/**
 * ALF-004: published whenever `@awthaq/password` bulk-revokes sessions as
 * part of a credential change — `confirmReset`'s `revokeAll` (no
 * authenticated "current" session to keep) and `changePassword`'s
 * `revokeOthers` (the caller's own session survives, rotated) alike. Carries
 * no `sessionId`: the underlying `Sessions.revokeAll`/`revokeOthers`
 * primitives are bulk operations with no per-row identity to report.
 */
export interface SessionRevokedEvent {
  readonly _tag: "auth.session.revoked";
  readonly userId: UserId;
  readonly reason: "passwordChanged" | "passwordReset";
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

/** Published by `@awthaq/organization`'s `removeTeamMember`. */
export interface OrganizationTeamMemberRemovedEvent {
  readonly _tag: "auth.organization.teamMemberRemoved";
  readonly organizationId: string;
  readonly teamId: string;
  readonly userId: UserId;
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
  | PasswordChangedEvent
  | PasswordResetCompletedEvent
  | PasskeyCounterAnomalyEvent
  | AdminImpersonationStartedEvent
  | AdminImpersonationStoppedEvent
  | AdminImpersonationDeniedEvent
  | AdminActionDeniedEvent
  | AdminUserUpdatedEvent
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
  | OrganizationTeamDeletedEvent
  | OrganizationTeamMemberAddedEvent
  | OrganizationTeamMemberRemovedEvent;

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
