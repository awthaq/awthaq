// @awthaq/organization — OrganizationInvitations
//
// Invitations as a system interface (ADR-EA-040): creating one (an emailed capability for one address),
// accepting, rejecting and cancelling it. The invitee's acts (`accept`, `reject`) are not an authorization
// decision at all: the capability is the emailed token plus the invitee's own address, so they take the
// invitee's user id and no `Actor`. Who may *invite* or *cancel* is the authorized layer's.
//
// What each operation means lives here once:
//
//   create  — suspension, the per-inviter quota, the team, the veto, role names and the `Bound`, the
//             member check (a stale pending invitation is cancelled, and says so), resend rotation,
//             the mail (EEM-002)
//   accept  — veto first, the token (MTI-010), expiry, the invitee's address (FAMS-002), email
//             verification (EP-010), the membership and team limits, then ONE transaction: the
//             membership, the status and the team membership (D3); events; observe points (D7)
//
// Events and observe points run after the module's own transaction ends.

import { AuthEvents, Errors, HookPoint, Users } from "@awthaq/core";
import { Defects, Hmac, Mailer, SqlTransaction, Tenant } from "@awthaq/ports";
import { TenantScoped } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as InvitationRecords from "./InvitationRecords.ts";
import * as MembershipRecords from "./MembershipRecords.ts";
import * as OrganizationActor from "./OrganizationActor.ts";
import * as OrganizationAuthority from "./OrganizationAuthority.ts";
import { OrganizationConfig } from "./OrganizationConfig.ts";
import * as OrganizationDirectory from "./OrganizationDirectory.ts";
import * as OrganizationErrors from "./OrganizationErrors.ts";
import * as OrganizationHooks from "./OrganizationHooks.ts";
import * as PermissionEngine from "./PermissionEngine.ts";
import * as TeamRecords from "./TeamRecords.ts";
import { requireWithin } from "./internal/bound.ts";
import { ownsEmail } from "./internal/invitee.ts";
import { limitsOf } from "./internal/limits.ts";
import { hexOf, NO_INVITATION_TOKEN_HASH } from "./internal/tokens.ts";

export type Invitation = InvitationRecords.InvitationRecord;

// ---- cross-organization witnesses (plan 05, ADR-EA-018 decision 10) ----------------------

/** The invitation id alone is the capability. */
const invitationIdGrant = TenantScoped.crossTenant(
  "organization: the invitation id is the capability; acceptance re-checks the invitee's email",
);
/** The emailed token's hash is the capability. */
const invitationTokenGrant = TenantScoped.crossTenant(
  "organization: the emailed token's hash is the capability; the landing lookup then checks the invitee's email",
);
/** An invitee's own pending invitations, whichever organizations sent them. */
const inviteeGrant = TenantScoped.crossTenant(
  "organization: the invitee's own pending invitations, keyed by their verified email",
);
/** The per-inviter quota is deployment-wide. */
const inviterQuotaGrant = TenantScoped.crossTenant(
  "organization: per-inviter invitation quota, deployment-wide by design (invitationLimit)",
);

export interface OrganizationInvitationsShape {
  /** An invitation by its id (the id is a lookup key, not a capability: callers authorize the read). */
  readonly find: (
    invitationId: string,
  ) => Effect.Effect<Option.Option<Invitation>, Errors.StoreUnavailable>;
  /** The invitation an emailed token names, if any (the token's hash is the key). */
  readonly findByToken: (
    token: string,
  ) => Effect.Effect<Option.Option<Invitation>, Errors.StoreUnavailable>;
  readonly listForOrganization: (
    organizationId: string,
  ) => Effect.Effect<ReadonlyArray<Invitation>, Errors.StoreUnavailable>;
  readonly listPendingForOrganization: (
    organizationId: string,
  ) => Effect.Effect<ReadonlyArray<Invitation>, Errors.StoreUnavailable>;
  /** FAMS-002: the invitations addressed to the user's own email (none for a user with no email). */
  readonly listForUser: (
    userId: Users.UserId,
  ) => Effect.Effect<ReadonlyArray<Invitation>, Errors.StoreUnavailable>;
  readonly listForEmail: (
    email: string,
  ) => Effect.Effect<ReadonlyArray<Invitation>, Errors.StoreUnavailable>;
  /** True iff the token hashes to this invitation's stored hash (constant time; MTI-010). */
  readonly holdsToken: (invitation: Invitation, token: string) => Effect.Effect<boolean>;

  /**
   * Invites an address. Order: suspension, the inviter's pending quota (with `limitsFor`), the team (teams on,
   * the team exists), the veto point, known role names and the `Bound` over the vetoed roles, the member
   * check (a stale pending invitation for a member is cancelled, with `invitationCanceled`, and the call is
   * `AlreadyMember`), the resend rule (`cancelPendingInvitationsOnReInvite`, `resend` rotates the token and
   * runs the observe point again), the write, `invitationCreated`, `AfterCreateInvitation` and the mail. A
   * delivery failure leaves the invitation pending (`resend: true` retries).
   */
  readonly create: (
    actor: OrganizationActor.Actor,
    input: {
      readonly organizationId: string;
      readonly inviterId: Users.UserId;
      readonly email: string;
      readonly role: ReadonlyArray<string>;
      readonly teamId?: string | undefined;
      readonly resend?: boolean | undefined;
      readonly bound: OrganizationActor.Bound;
    },
  ) => Effect.Effect<
    Invitation,
    | OrganizationErrors.OrganizationNotFound
    | OrganizationErrors.InvitationLimitReached
    | OrganizationErrors.InvitationDeliveryFailed
    | OrganizationErrors.AlreadyMember
    | OrganizationErrors.TeamsDisabled
    | OrganizationErrors.TeamNotFound
    | OrganizationErrors.RolePermissionEscalation
    | OrganizationErrors.UnknownOrgRole
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /**
   * The invitee's act. The veto point runs first (unchanged), then the token, expiry (an expired invitation
   * becomes `expired` and `invitationExpired` is published), the invitee's address, email verification
   * (EP-010), the membership and team-member limits, then ONE transaction for the membership, the status and
   * the team membership (D3), `invitationAccepted`, `memberAdded`, `teamMemberAdded`, and the observe points
   * (`AfterAddMember` and `AfterAddTeamMember` included, D7).
   */
  readonly accept: (input: {
    readonly invitationId: string;
    readonly token: string;
    readonly userId: Users.UserId;
  }) => Effect.Effect<
    MembershipRecords.MembershipRecord,
    | OrganizationErrors.InvitationNotFound
    | OrganizationErrors.InvitationNotPending
    | OrganizationErrors.InvitationExpired
    | OrganizationErrors.InvitationEmailMismatch
    | OrganizationErrors.MembershipLimitReached
    | OrganizationErrors.AlreadyMember
    | OrganizationErrors.EmailVerificationRequired
    | OrganizationErrors.TeamMemberLimitReached
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly reject: (input: {
    readonly invitationId: string;
    readonly token: string;
    readonly userId: Users.UserId;
  }) => Effect.Effect<
    void,
    | OrganizationErrors.InvitationNotFound
    | OrganizationErrors.InvitationNotPending
    | OrganizationErrors.InvitationEmailMismatch
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /** Pending only. Authorization (MTI-009 and `invitation:cancel`) is the caller's (D6): the veto runs after it. */
  readonly cancel: (
    actor: OrganizationActor.Actor,
    input: { readonly invitationId: string },
  ) => Effect.Effect<
    void,
    | OrganizationErrors.InvitationNotFound
    | OrganizationErrors.InvitationNotPending
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
}

export class OrganizationInvitations extends Context.Service<
  OrganizationInvitations,
  OrganizationInvitationsShape
>()("awthaq/plugin/organization/Invitations") {
  static readonly layer = Layer.effect(
    OrganizationInvitations,
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const members = yield* MembershipRecords.MembershipRecords;
      const invitations = yield* InvitationRecords.InvitationRecords;
      const teams = yield* TeamRecords.TeamRecords;
      const authority = yield* OrganizationAuthority.OrganizationAuthority;
      const users = yield* Users.Users;
      const mailer = yield* Mailer.Mailer;
      const sqlTransaction = yield* SqlTransaction.SqlTransaction;
      const crypto = yield* Crypto.Crypto;
      // EP-007 (ADR-EA-018): the configuration in force is decided per operation.
      const builtConfig = yield* OrganizationConfig;
      const configNow = Tenant.configInForce(OrganizationConfig, builtConfig);
      const beforeCreate = yield* OrganizationHooks.BeforeCreateInvitation;
      const afterCreate = yield* OrganizationHooks.AfterCreateInvitation;
      const beforeAccept = yield* OrganizationHooks.BeforeAcceptInvitation;
      const afterAccept = yield* OrganizationHooks.AfterAcceptInvitation;
      const beforeReject = yield* OrganizationHooks.BeforeRejectInvitation;
      const afterReject = yield* OrganizationHooks.AfterRejectInvitation;
      const beforeCancel = yield* OrganizationHooks.BeforeCancelInvitation;
      const afterCancel = yield* OrganizationHooks.AfterCancelInvitation;
      const afterAddMember = yield* OrganizationHooks.AfterAddMember;
      const afterAddTeamMember = yield* OrganizationHooks.AfterAddTeamMember;

      /** Hex SHA-256 of an invitation token: the only form of it ever stored. */
      const hashToken = (token: string) =>
        crypto
          .digest("SHA-256", new TextEncoder().encode(token))
          .pipe(Effect.map(hexOf), Effect.orDie);

      const mintToken = Effect.gen(function* () {
        const token = hexOf(yield* crypto.randomBytes(32).pipe(Effect.orDie));
        return { token, tokenHash: yield* hashToken(token) };
      });

      /**
       * MTI-010: proves the caller holds the emailed token for `invitationId` (constant-time hash comparison). An
       * unknown id, a wrong token and a pre-column invitation with no stored hash all answer the same
       * `InvitationNotFound`, so knowing an id reveals nothing.
       */
      const requireInvitationToken = (invitationId: string, token: string) =>
        Effect.gen(function* () {
          const found = yield* invitations.findById(invitationIdGrant, invitationId);
          const presented = yield* hashToken(token);
          const stored = Option.flatMap(found, (record) => record.tokenHash);
          const matches = Hmac.constantTimeEqualString(
            presented,
            Option.getOrElse(stored, () => NO_INVITATION_TOKEN_HASH),
          );
          if (Option.isNone(found) || Option.isNone(stored) || !matches) {
            return yield* new OrganizationErrors.InvitationNotFound();
          }
          return found.value;
        });

      const requirePendingInvitation = (invitationId: string, token: string) =>
        requireInvitationToken(invitationId, token).pipe(
          Effect.flatMap((record) =>
            record.status === "pending"
              ? Effect.succeed(record)
              : Effect.fail(new OrganizationErrors.InvitationNotPending()),
          ),
        );

      /** Cancels a pending invitation and says so (D8): every cancellation is an event. */
      const cancelAndAnnounce = (actor: OrganizationActor.Actor, record: Invitation) =>
        invitations.updateStatus(record.organizationId, record.id, "canceled").pipe(
          Effect.catchTag("InvitationRecordNotFound", Effect.die),
          Effect.andThen(
            events.publish({
              _tag: "auth.organization.invitationCanceled",
              actorUserId: OrganizationActor.userIdOf(actor),
              invitationId: record.id,
              organizationId: record.organizationId,
            }),
          ),
        );

      // ---- reads ----------------------------------------------------------------------

      const find: OrganizationInvitationsShape["find"] = (invitationId) =>
        invitations.findById(invitationIdGrant, invitationId);

      const findByToken: OrganizationInvitationsShape["findByToken"] = (token) =>
        hashToken(token).pipe(
          Effect.flatMap((hash) => invitations.findByTokenHash(invitationTokenGrant, hash)),
        );

      const listForOrganization: OrganizationInvitationsShape["listForOrganization"] = (
        organizationId,
      ) => invitations.listByOrganization(organizationId);

      const listPendingForOrganization: OrganizationInvitationsShape["listPendingForOrganization"] =
        (organizationId) =>
          invitations
            .listByOrganization(organizationId)
            .pipe(Effect.map((rows) => rows.filter((row) => row.status === "pending")));

      const listForEmail: OrganizationInvitationsShape["listForEmail"] = (email) =>
        invitations.listByEmail(inviteeGrant, email);

      const listForUser: OrganizationInvitationsShape["listForUser"] = Effect.fnUntraced(
        function* (userId) {
          const user = yield* users.findById(userId).pipe(Effect.orDie);
          // FAMS-002: a Phone/Anonymous user has no email, so no invitation can name them.
          return yield* Option.match(Users.emailOf(user), {
            onNone: () => Effect.succeed([]),
            onSome: listForEmail,
          });
        },
      );

      const holdsToken: OrganizationInvitationsShape["holdsToken"] = (invitation, token) =>
        hashToken(token).pipe(
          Effect.map((presented) =>
            Option.exists(invitation.tokenHash, (stored) =>
              Hmac.constantTimeEqualString(presented, stored),
            ),
          ),
        );

      // ---- create -----------------------------------------------------------------------

      const create: OrganizationInvitationsShape["create"] = Effect.fnUntraced(
        function* (actor, input) {
          const { organizationId, inviterId, bound } = input;
          const orgConfig = yield* configNow;
          const organizationRecord = yield* directory.requireActive(organizationId);

          const pendingCount = yield* invitations.countPendingByInviter(
            inviterQuotaGrant,
            inviterId,
          );
          if (pendingCount >= (yield* limitsOf(orgConfig, organizationId)).invitationLimit) {
            return yield* new OrganizationErrors.InvitationLimitReached();
          }

          if (input.teamId !== undefined) {
            if (!orgConfig.teams.enabled) return yield* new OrganizationErrors.TeamsDisabled();
            const team = yield* teams.findTeamById(organizationId, input.teamId);
            if (Option.isNone(team)) return yield* new OrganizationErrors.TeamNotFound();
          }

          const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeCreateInvitation)(
            beforeCreate.run({
              actor,
              organizationId,
              email: input.email,
              role: input.role,
            }),
          );
          // RRM-002: an invitation can only confer statements its source holds, over known role names.
          const byRole = yield* authority.statementsByRole(organizationId);
          if (vetoed.role.some((name) => !byRole.has(name))) {
            return yield* new OrganizationErrors.UnknownOrgRole();
          }
          yield* requireWithin(bound, PermissionEngine.effectivePermissions(vetoed.role, byRole));

          const alreadyMember = yield* users.findByEmail(vetoed.email).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(Option.none<MembershipRecords.MembershipRecord>()),
                onSome: (user) => members.findByUserAndOrg(user.id, organizationId),
              }),
            ),
          );
          const existing = yield* invitations.findPendingByEmailAndOrg(
            vetoed.email,
            organizationId,
          );

          // OHS-006: an existing member is never invited again (an invitation could otherwise overwrite
          // or duplicate the membership on accept); any pending invitation for them is stale, so cancel it.
          if (Option.isSome(alreadyMember)) {
            if (Option.isSome(existing)) yield* cancelAndAnnounce(actor, existing.value);
            return yield* new OrganizationErrors.AlreadyMember();
          }

          const expiresAt = yield* DateTime.now.pipe(
            Effect.map((now) => DateTime.addDuration(now, orgConfig.invitationExpiresIn)),
          );

          // MTI-010: the mailed capability is a fresh random token (only its hash is stored), never the
          // invitation's own id. EEM-002: the inviter is authenticated, so a delivery failure is surfaced
          // (the invitation stays pending; re-inviting with `resend: true` retries) rather than swallowed.
          const sendInvite = (record: Invitation, token: string) =>
            mailer
              .send({
                to: record.email,
                template: "organization-invite",
                data: {
                  token,
                  invitationId: record.id,
                  organizationId,
                  organizationName: organizationRecord.name,
                  // EP-005: the mail is rendered to the tenant's own users, so it carries the tenant's
                  // presentation data, not the host's.
                  organizationLogo: Option.getOrNull(organizationRecord.logo),
                  role: record.role,
                },
              })
              .pipe(
                Effect.catchTag(
                  "MailDeliveryFailed",
                  () =>
                    new OrganizationErrors.InvitationDeliveryFailed({ invitationId: record.id }),
                ),
              );

          if (Option.isSome(existing)) {
            if (orgConfig.cancelPendingInvitationsOnReInvite) {
              yield* cancelAndAnnounce(actor, existing.value);
            } else if (input.resend) {
              // A resend mints a new token (only the hash is kept, so the old mail cannot be re-sent)
              // and retires the previous one.
              const fresh = yield* mintToken;
              const rotated = yield* invitations
                .setTokenHash(existing.value.organizationId, existing.value.id, fresh.tokenHash)
                .pipe(Effect.catchTag("InvitationRecordNotFound", Effect.die));
              yield* events.publish({
                _tag: "auth.organization.invitationCreated",
                actorUserId: OrganizationActor.userIdOf(actor),
                invitationId: rotated.id,
                organizationId,
              });
              yield* afterCreate.run({
                actor,
                organizationId,
                email: rotated.email,
                role: rotated.role,
                invitationId: rotated.id,
              });
              yield* sendInvite(rotated, fresh.token);
              return rotated;
            } else {
              return existing.value;
            }
          }

          const minted = yield* mintToken;
          const record = yield* invitations.create({
            email: vetoed.email,
            inviterId,
            organizationId,
            teamId: input.teamId,
            role: vetoed.role,
            expiresAt,
            tokenHash: minted.tokenHash,
          });
          // The record exists from here on, so its creation is published before the mail attempt: a
          // delivery failure leaves a pending invitation, not a phantom one.
          yield* events.publish({
            _tag: "auth.organization.invitationCreated",
            actorUserId: OrganizationActor.userIdOf(actor),
            invitationId: record.id,
            organizationId,
          });
          yield* afterCreate.run({
            actor,
            organizationId,
            email: record.email,
            role: vetoed.role,
            invitationId: record.id,
          });
          yield* sendInvite(record, minted.token);
          return record;
        },
      );

      // ---- accept / reject / cancel -------------------------------------------------------

      const accept: OrganizationInvitationsShape["accept"] = Effect.fnUntraced(function* (input) {
        const { invitationId, token, userId } = input;
        const actor = OrganizationActor.ActorSchema.cases.User.make({ userId });
        yield* HookPoint.aborted(OrganizationHooks.BeforeAcceptInvitation)(
          beforeAccept.run({ actor, invitationId }),
        );

        const record = yield* requirePendingInvitation(invitationId, token);
        const orgConfig = yield* configNow;

        const now = yield* DateTime.now;
        if (DateTime.isGreaterThan(now, record.expiresAt)) {
          yield* invitations
            .updateStatus(record.organizationId, invitationId, "expired")
            .pipe(Effect.catchTag("InvitationRecordNotFound", Effect.die));
          // D8: an invitation that lapsed is announced.
          yield* events.publish({
            _tag: "auth.organization.invitationExpired",
            actorUserId: OrganizationActor.userIdOf(actor),
            invitationId,
            organizationId: record.organizationId,
          });
          return yield* new OrganizationErrors.InvitationExpired();
        }

        const user = yield* users.findById(userId).pipe(Effect.orDie);
        if (!ownsEmail(user, record.email)) {
          return yield* new OrganizationErrors.InvitationEmailMismatch();
        }
        if (orgConfig.requireEmailVerificationOnInvitation && !Users.isEmailVerified(user)) {
          return yield* new OrganizationErrors.EmailVerificationRequired();
        }

        // OHS-006: accepting can never overwrite or duplicate a membership: the invitation is stale
        // (the user was admitted another way), so it is cancelled and the existing roles stay untouched.
        const alreadyMember = yield* members.findByUserAndOrg(userId, record.organizationId);
        if (Option.isSome(alreadyMember)) {
          yield* cancelAndAnnounce(actor, record);
          return yield* new OrganizationErrors.AlreadyMember();
        }

        const limits = yield* limitsOf(orgConfig, record.organizationId);
        const count = yield* members.countByOrganization(record.organizationId);
        if (count >= limits.membershipLimit) {
          return yield* new OrganizationErrors.MembershipLimitReached();
        }

        if (Option.isSome(record.teamId)) {
          const team = yield* teams.findTeamById(record.organizationId, record.teamId.value).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Defects.invariantViolation(
                    "RowVanished",
                    "awthaq: invitation's team vanished before acceptance",
                  ),
                onSome: Effect.succeed,
              }),
            ),
          );
          if (team.memberCount >= limits.maximumMembersPerTeam) {
            return yield* new OrganizationErrors.TeamMemberLimitReached();
          }
        }

        // D3: the membership, the status and the team membership are one unit: an acceptance that
        // fails midway leaves the invitation pending and no half-made membership behind.
        const { membership, joinedTeam } = yield* sqlTransaction
          .withTransaction(
            Effect.gen(function* () {
              const created = yield* members
                .create({
                  userId,
                  organizationId: record.organizationId,
                  role: record.role,
                })
                .pipe(
                  Effect.catchTag("MembershipRecordAlreadyExists", () =>
                    Effect.fail(new OrganizationErrors.AlreadyMember()),
                  ),
                );
              return yield* Effect.gen(function* () {
                yield* invitations
                  .updateStatus(record.organizationId, invitationId, "accepted")
                  .pipe(Effect.catchTag("InvitationRecordNotFound", Effect.die));
                // OHS-003: the team half of accepting stays idempotent: a user who is already on
                // the team is not double-counted.
                const joined = Option.isSome(record.teamId)
                  ? yield* teams.addTeamMember({ teamId: record.teamId.value, userId }).pipe(
                      Effect.as(true),
                      Effect.catchTag("TeamMembershipRecordAlreadyExists", () =>
                        Effect.succeed(false),
                      ),
                    )
                  : false;
                return { membership: created, joinedTeam: joined };
              }).pipe(
                // A backend without transactions (`layerNoop`) cannot roll back: undo the membership
                // (and the team membership it cascades) so a failed acceptance leaves nothing behind.
                Effect.onError(() =>
                  Effect.ignore(
                    members
                      .remove(userId, record.organizationId)
                      .pipe(
                        Effect.andThen(
                          teams.removeUserFromOrganizationTeams(record.organizationId, userId),
                        ),
                      ),
                  ),
                ),
              );
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));

        yield* events.publish({
          _tag: "auth.organization.invitationAccepted",
          actorUserId: OrganizationActor.userIdOf(actor),
          invitationId,
          organizationId: record.organizationId,
          userId,
        });
        yield* events.publish({
          _tag: "auth.organization.memberAdded",
          actorUserId: OrganizationActor.userIdOf(actor),
          organizationId: record.organizationId,
          userId,
          role: membership.role,
        });
        if (joinedTeam && Option.isSome(record.teamId)) {
          yield* events.publish({
            _tag: "auth.organization.teamMemberAdded",
            actorUserId: OrganizationActor.userIdOf(actor),
            organizationId: record.organizationId,
            teamId: record.teamId.value,
            userId,
          });
        }
        yield* afterAccept.run({
          actor,
          invitationId,
          organizationId: record.organizationId,
          userId,
        });
        // D7: a membership created here is observable like any other.
        yield* afterAddMember.run({
          actor,
          organizationId: record.organizationId,
          userId,
          role: membership.role,
        });
        if (joinedTeam && Option.isSome(record.teamId)) {
          yield* afterAddTeamMember.run({
            actor,
            organizationId: record.organizationId,
            teamId: record.teamId.value,
            userId,
            role: ["member"],
          });
        }
        return membership;
      });

      const reject: OrganizationInvitationsShape["reject"] = Effect.fnUntraced(function* (input) {
        const { invitationId, token, userId } = input;
        const actor = OrganizationActor.ActorSchema.cases.User.make({ userId });
        yield* HookPoint.aborted(OrganizationHooks.BeforeRejectInvitation)(
          beforeReject.run({ actor, invitationId }),
        );
        const record = yield* requirePendingInvitation(invitationId, token);
        const user = yield* users.findById(userId).pipe(Effect.orDie);
        if (!ownsEmail(user, record.email)) {
          return yield* new OrganizationErrors.InvitationEmailMismatch();
        }
        yield* invitations
          .updateStatus(record.organizationId, invitationId, "rejected")
          .pipe(Effect.catchTag("InvitationRecordNotFound", Effect.die));
        yield* events.publish({
          _tag: "auth.organization.invitationRejected",
          actorUserId: OrganizationActor.userIdOf(actor),
          invitationId,
          organizationId: record.organizationId,
        });
        yield* afterReject.run({ actor, invitationId });
      });

      const cancel: OrganizationInvitationsShape["cancel"] = Effect.fnUntraced(
        function* (actor, input) {
          const { invitationId } = input;
          const found = yield* invitations.findById(invitationIdGrant, invitationId);
          if (Option.isNone(found)) return yield* new OrganizationErrors.InvitationNotFound();
          const record = found.value;
          if (record.status !== "pending")
            return yield* new OrganizationErrors.InvitationNotPending();
          yield* HookPoint.aborted(OrganizationHooks.BeforeCancelInvitation)(
            beforeCancel.run({ actor, invitationId }),
          );
          yield* cancelAndAnnounce(actor, record);
          yield* afterCancel.run({ actor, invitationId });
        },
      );

      return OrganizationInvitations.of({
        find,
        findByToken,
        listForOrganization,
        listPendingForOrganization,
        listForUser,
        listForEmail,
        holdsToken,
        create,
        accept,
        reject,
        cancel,
      });
    }),
  );
}
