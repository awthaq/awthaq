// Temporary (plan 09 phases 1-2): the pre-`defineEvent` actor switch, kept verbatim so the parity test
// can prove the generic reader agrees with it for every event. Deleted in phase 3.
import * as Option from "effect/Option";
import type { AuthEvent } from "../AuthEventSchemas.ts";
import { UserId } from "../Users.ts";

/**
 * Exhaustive by construction: TypeScript forces this to be updated whenever
 * `AuthEvent`'s union grows, so audit-actor coverage can never silently lag
 * the registry the way BEH-EA-101 already worries about for subscribers.
 */
export const legacyActorOf = (event: AuthEvent): Option.Option<UserId> => {
  switch (event._tag) {
    case "auth.user.created":
    case "auth.user.signedIn":
    case "auth.user.emailVerified":
    case "auth.user.emailChanged":
    // receipt: the erased id stays the actor, whoever initiated (ADR-EA-029 §4).
    case "auth.user.deleted":
    case "auth.user.dataExported":
    case "auth.session.reuse":
    case "auth.session.issued":
    case "auth.session.rotated":
    case "auth.session.superseded":
    case "auth.session.revoked":
    case "auth.session.expired":
    case "auth.password.changed":
    case "auth.password.resetRequested":
    case "auth.password.resetCompleted":
    case "auth.passkey.counterAnomaly":
    case "auth.organization.memberAdded":
    case "auth.organization.memberRemoved":
    case "auth.organization.memberRoleUpdated":
    case "auth.organization.invitationAccepted":
    case "auth.organization.teamMemberAdded":
    case "auth.organization.teamMemberRoleUpdated":
    case "auth.organization.teamMemberRemoved":
    case "auth.organization.permissionDenied":
    case "auth.twoFactor.enabled":
    case "auth.twoFactor.disabled":
    case "auth.twoFactor.verified":
    case "auth.twoFactor.challengeFailed":
    case "auth.twoFactor.recoveryCodeUsed":
    case "auth.twoFactor.recoveryCodesRegenerated":
    case "auth.twoFactor.locked":
    case "auth.apiKey.created":
    case "auth.apiKey.revoked":
    case "auth.apiKey.rotated":
    case "auth.apiKey.clientRegistered":
    case "auth.apiKey.clientRevoked":
    case "auth.apiKey.clientSecretRotated":
    case "auth.deviceAuthorization.approved":
    case "auth.deviceAuthorization.denied":
      return Option.some(UserId(event.userId));
    case "auth.admin.impersonationStarted":
    case "auth.admin.impersonationStopped":
    case "auth.admin.impersonationDenied":
    case "auth.admin.actionDenied":
    case "auth.admin.userUpdated":
    case "auth.admin.userBanned":
    case "auth.admin.userUnbanned":
    case "auth.admin.userDeleted":
    case "auth.admin.userEmailChangeRequested":
    case "auth.admin.userPasswordSet":
    case "auth.admin.sessionRevoked":
    case "auth.admin.organizationSuspended":
    case "auth.admin.organizationUnsuspended":
    case "auth.webhooks.endpointCreated":
    case "auth.webhooks.endpointUpdated":
    case "auth.webhooks.secretRotated":
    case "auth.webhooks.endpointDeleted":
    case "auth.webhooks.testQueued":
    case "auth.saml.connectionCreated":
    case "auth.saml.connectionUpdated":
    case "auth.saml.connectionDeleted":
    case "auth.saml.signingKeyRotated":
      return Option.some(UserId(event.adminUserId));
    case "auth.mail.failed":
      return Option.fromNullishOr(event.userId).pipe(Option.map(UserId));
    case "auth.roles.assigned":
    case "auth.roles.revoked":
    case "auth.user.claimsUpdated":
      // The actor is who *changed* the roles, not whose roles changed.
      return Option.fromNullishOr(event.actorUserId).pipe(Option.map(UserId));
    case "auth.authz.denied":
      // qadi's own subject id: only a `user:` subject names an awthaq user.
      return event.subjectId.startsWith("user:")
        ? Option.some(UserId(event.subjectId.slice("user:".length)))
        : Option.none();
    case "auth.organization.created":
      return Option.some(UserId(event.creatorUserId));
    case "auth.token.replay":
    case "auth.rateLimit.exceeded":
    case "auth.user.signInFailed":
    // CWM-002: a directory acts, not a user — the connection id rides in the payload.
    case "auth.scim.userProvisioned":
    case "auth.scim.userDeactivated":
    case "auth.scim.userReactivated":
    case "auth.scim.userDeleted":
    case "auth.scim.groupChanged":
    // `@awthaq/saml`: a logout message that named no verified user.
    case "auth.saml.logoutRejected":
    // ECS-006/ECS-002: a CLI run has no session, so no actor; the seeded target is in the payload.
    case "auth.admin.seeded":
    case "auth.admin.seedRefused":
    case "auth.import.completed":
    case "auth.import.failed":
    case "auth.organization.updated":
    case "auth.organization.deleted":
    case "auth.organization.invitationCreated":
    case "auth.organization.invitationRejected":
    case "auth.organization.invitationCanceled":
    case "auth.organization.roleCreated":
    case "auth.organization.roleUpdated":
    case "auth.organization.roleDeleted":
    case "auth.organization.teamCreated":
    case "auth.organization.teamUpdated":
    case "auth.organization.teamMoved":
    case "auth.organization.teamDeleted":
      return Option.none();
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};
