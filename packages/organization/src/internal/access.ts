// @awthaq/organization — OrganizationAccess: organization authorization as one primitive (package-private)
//
// Plan 30 Part A, ADR-EA-040 decision 6. Every organization-scoped method of the authorized interface
// (`Organization.ts`) obtains an access proof here before it calls a system interface. The order is
// written once per entry point and nowhere else:
//
//   1. the organization is active (EP-003);
//   2. the caller is a member (MTI-009; a statement-gated entry records `notMember`, PERS-005);
//   3. the feature gate (PV-300: after membership, so a non-member's answer never depends on a feature);
//   4. the statement, held in the caller's statements in scope (`missingStatement` on a miss).
//
// A proof carries the organization id it was checked against, the `User` actor and, for a statement,
// the grant ceiling `OrganizationAuthority` minted from the same read. Proofs are branded and minted
// only in this file (the AdminGate clearance idiom); `AuthorizationBoundary.test.ts` keeps it so.
//
// Never re-exported by `index.ts`.

import type { Api } from "@awthaq/api";
import { AuthEvents, Users } from "@awthaq/core";
import { Tenant } from "@awthaq/ports";
import * as Brand from "effect/Brand";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as OrganizationActor from "../OrganizationActor.ts";
import * as OrganizationAuthority from "../OrganizationAuthority.ts";
import { OrganizationConfig } from "../OrganizationConfig.ts";
import * as OrganizationDirectory from "../OrganizationDirectory.ts";
import * as OrganizationErrors from "../OrganizationErrors.ts";
import * as OrganizationInvitations from "../OrganizationInvitations.ts";
import * as OrganizationMembers from "../OrganizationMembers.ts";
import * as OrganizationRoles from "../OrganizationRoles.ts";
import * as OrganizationTeams from "../OrganizationTeams.ts";
import type * as PermissionEngine from "../PermissionEngine.ts";
import { ownsEmail } from "./invitee.ts";

/** The built-in statement resources the authorized interface gates (`PermissionEngine.defaultStatements`). */
export type Resource = "organization" | "member" | "invitation" | "team" | "role";

/** One statement an endpoint needs. */
export interface Statement<R extends Resource = Resource, A extends string = string> {
  readonly resource: R;
  readonly action: A;
}

/** `const` type parameters keep the literals, so a proof names the statement it was minted for. */
export const statement = <const R extends Resource, const A extends string>(
  resource: R,
  action: A,
): Statement<R, A> => ({ resource, action });

/** EP-003 and MTI-009 passed: the organization is active and the caller is one of its members. */
export type MemberAccess = {
  readonly organizationId: string;
  /** The active organization, as read by the check (no second read for `get`). */
  readonly organization: OrganizationDirectory.Organization;
  /** Always the `User` case, built from the principal here and nowhere else. */
  readonly actor: OrganizationActor.Actor;
  readonly membership: OrganizationMembers.Membership;
} & Brand.Brand<"awthaq/organization/MemberAccess">;

/** `MemberAccess` plus a statement held in scope, and the ceiling of what this caller may confer. */
export type StatementAccess<R extends Resource, A extends string> = {
  readonly statement: Statement<R, A>;
  readonly organizationId: string;
  readonly organization: OrganizationDirectory.Organization;
  readonly actor: OrganizationActor.Actor;
  readonly membership: OrganizationMembers.Membership;
  /** The statements the decision read: organization level, or merged with the team subtree's (OHS-004). */
  readonly statements: PermissionEngine.Statements;
  /** RRM-001 / OHS-004: `Ceiling(statements)`, minted by `OrganizationAuthority` from the same read. */
  readonly bound: OrganizationActor.Bound;
} & Brand.Brand<"awthaq/organization/StatementAccess">;

// Module-local: the only constructors of the two proofs.
const memberAccessOf = Brand.nominal<MemberAccess>();
const statementAccessOf = <R extends Resource, A extends string>() =>
  Brand.nominal<StatementAccess<R, A>>();

/** Yielded once at the top of the plugin's `make` (a service captured in a handler closure leaks into the handler's requirements). */
export const make = Effect.gen(function* () {
  const directory = yield* OrganizationDirectory.OrganizationDirectory;
  const members = yield* OrganizationMembers.OrganizationMembers;
  const invitations = yield* OrganizationInvitations.OrganizationInvitations;
  const teams = yield* OrganizationTeams.OrganizationTeams;
  const roles = yield* OrganizationRoles.OrganizationRoles;
  const authority = yield* OrganizationAuthority.OrganizationAuthority;
  const events = yield* AuthEvents.AuthEvents;
  const users = yield* Users.Users;
  // EP-007: the configuration in force is decided per operation (the tenant middleware may override it).
  const configNow = Tenant.configInForce(OrganizationConfig, yield* OrganizationConfig);

  const callerId = (caller: Api.UserPrincipal) => Users.UserId(caller.ref.id);
  const actorOf = (caller: Api.UserPrincipal) =>
    OrganizationActor.ActorSchema.cases.User.make({
      userId: caller.ref.id,
      sessionId: caller.sessionId,
    });

  /** PERS-005: a denied statement-gated operation leaves a durable who/what/why (attempt lane, ADR-EA-037). */
  const denied = (
    caller: Api.UserPrincipal,
    organizationId: string,
    wanted: Statement,
    reason: "notMember" | "missingStatement",
  ) =>
    events.publish({
      _tag: "auth.organization.permissionDenied",
      organizationId,
      userId: callerId(caller),
      resource: wanted.resource,
      action: wanted.action,
      reason,
    });

  // ---- steps (private): only the entry points below compose them, always in this order --------

  /** EP-003 then MTI-009: a suspended, unknown or not-a-member organization is one answer. */
  const visibleMembership = Effect.fnUntraced(function* (
    caller: Api.UserPrincipal,
    organizationId: string,
    audited: Statement | undefined,
  ) {
    const organization = yield* directory.requireActive(organizationId);
    const found = yield* members.find(organizationId, callerId(caller));
    if (Option.isNone(found)) {
      if (audited !== undefined) yield* denied(caller, organizationId, audited, "notMember");
      return yield* new OrganizationErrors.OrganizationNotFound();
    }
    return memberAccessOf({
      organizationId,
      organization,
      actor: actorOf(caller),
      membership: found.value,
    });
  });

  /** The statement on the statements in scope; `teamId` widens with team authority within this organization. */
  const granted = Effect.fnUntraced(function* <R extends Resource, A extends string>(
    caller: Api.UserPrincipal,
    base: MemberAccess,
    wanted: Statement<R, A>,
    teamId: string | undefined,
  ) {
    const { statements, bound } = yield* authority.scopedCeiling(
      base.organizationId,
      base.membership,
      teamId,
    );
    if (!authority.holds(statements, wanted)) {
      yield* denied(caller, base.organizationId, wanted, "missingStatement");
      return yield* new OrganizationErrors.OrganizationPermissionDenied();
    }
    return statementAccessOf<R, A>()({
      statement: wanted,
      organizationId: base.organizationId,
      organization: base.organization,
      actor: base.actor,
      membership: base.membership,
      statements,
      bound,
    });
  });

  /** The invitee of an invitation: a user whose own email address it names (FAMS-002). */
  const isInvitee = (caller: Api.UserPrincipal, email: string) =>
    users.findById(callerId(caller)).pipe(
      Effect.map((user) => ownsEmail(user, email)),
      Effect.catchTag("UserNotFound", () => Effect.succeed(false)),
    );

  /** BEH-EA-237 on a path that starts from an invitation: a suspended organization reads as no invitation. */
  const activeInvitation = (record: OrganizationInvitations.Invitation) =>
    directory
      .requireActive(record.organizationId)
      .pipe(
        Effect.catchTag("OrganizationNotFound", () =>
          Effect.fail(new OrganizationErrors.InvitationNotFound()),
        ),
      );

  // ---- entry points: the only places the order is written ---------------------------------

  /** `create`: who may create an organization at all (`allowUserToCreateOrganization`); the rest is the Directory's. */
  const creator = Effect.fnUntraced(function* (caller: Api.UserPrincipal) {
    const userId = callerId(caller);
    if (!(yield* (yield* configNow).allowUserToCreateOrganization(userId))) {
      return yield* new OrganizationErrors.OrganizationCreationNotAllowed();
    }
    return { userId, actor: actorOf(caller) };
  });

  /** Reads any member may use (get, getFull, listMembers, leave, listInvitationsForOrganization). */
  const member = (caller: Api.UserPrincipal, organizationId: string) =>
    visibleMembership(caller, organizationId, undefined);

  /** Team reads: membership BEFORE the gate (PV-300), so a non-member never sees `TeamsDisabled`. */
  const teamMember = Effect.fnUntraced(function* (
    caller: Api.UserPrincipal,
    organizationId: string,
  ) {
    const access = yield* visibleMembership(caller, organizationId, undefined);
    yield* teams.requireEnabled;
    return access;
  });

  /** An organization-scoped statement (update, delete, removeMember, updateMemberRole, invite). */
  const require = Effect.fnUntraced(function* <R extends Resource, A extends string>(
    caller: Api.UserPrincipal,
    organizationId: string,
    wanted: Statement<R, A>,
  ) {
    const access = yield* visibleMembership(caller, organizationId, wanted);
    return yield* granted(caller, access, wanted, undefined);
  });

  /** Dynamic roles: membership BEFORE the dynamic-access-control gate (A-F1), then the statement. */
  const requireRole = Effect.fnUntraced(function* <A extends string>(
    caller: Api.UserPrincipal,
    organizationId: string,
    wanted: Statement<"role", A>,
  ) {
    const access = yield* visibleMembership(caller, organizationId, wanted);
    yield* roles.requireEnabled;
    return yield* granted(caller, access, wanted, undefined);
  });

  /** Team writes: membership, the teams gate, then the statement on `teamId` (`undefined` = organization level). */
  const requireOnTeam = Effect.fnUntraced(function* <A extends string>(
    caller: Api.UserPrincipal,
    organizationId: string,
    wanted: Statement<"team", A>,
    teamId: string | undefined,
  ) {
    const access = yield* visibleMembership(caller, organizationId, wanted);
    yield* teams.requireEnabled;
    return yield* granted(caller, access, wanted, teamId);
  });

  /** A second team statement on the same visible membership (moveTeam's destination); no new membership read. */
  const alsoOnTeam = <A extends string>(
    caller: Api.UserPrincipal,
    proof: StatementAccess<"team", string>,
    wanted: Statement<"team", A>,
    teamId: string | undefined,
  ) =>
    granted(
      caller,
      memberAccessOf({
        organizationId: proof.organizationId,
        organization: proof.organization,
        actor: proof.actor,
        membership: proof.membership,
      }),
      wanted,
      teamId,
    );

  /**
   * An invitation id names its organization: resolve it, then EP-003 and MTI-009 on that organization,
   * every miss answered `InvitationNotFound`.
   */
  const invitation = Effect.fnUntraced(function* (
    caller: Api.UserPrincipal,
    invitationId: string,
    audited: Statement<"invitation", string> | undefined,
  ) {
    const found = yield* invitations.find(invitationId);
    if (Option.isNone(found)) return yield* new OrganizationErrors.InvitationNotFound();
    const access = yield* visibleMembership(caller, found.value.organizationId, audited).pipe(
      Effect.catchTag("OrganizationNotFound", () =>
        Effect.fail(new OrganizationErrors.InvitationNotFound()),
      ),
    );
    return { access, invitation: found.value };
  });

  /** A statement on an access already proven (cancelInvitation's `invitation:cancel` after its status check, D6). */
  const upgrade = <R extends Resource, A extends string>(
    caller: Api.UserPrincipal,
    base: MemberAccess,
    wanted: Statement<R, A>,
  ) => granted(caller, base, wanted, undefined);

  /**
   * `getInvitation`: a member holding `invitation:create`, or the invitee, of an active organization's
   * invitation. A read, so nothing is audited, and every refusal is `InvitationNotFound`.
   */
  const readInvitation = Effect.fnUntraced(function* (
    caller: Api.UserPrincipal,
    invitationId: string,
  ) {
    const found = yield* invitations.find(invitationId);
    if (Option.isNone(found)) return yield* new OrganizationErrors.InvitationNotFound();
    const asMember = yield* visibleMembership(caller, found.value.organizationId, undefined).pipe(
      Effect.map(Option.some),
      Effect.catchTag("OrganizationNotFound", () => Effect.succeedNone),
    );
    if (Option.isSome(asMember)) {
      const statements = yield* authority.scopedStatements(
        asMember.value.organizationId,
        asMember.value.membership,
        undefined,
      );
      if (authority.holds(statements, statement("invitation", "create"))) return found.value;
    }
    // The invitee is not a member, so the organization's suspension is checked on its own (A-F3).
    yield* activeInvitation(found.value);
    if (yield* isInvitee(caller, found.value.email)) return found.value;
    return yield* new OrganizationErrors.InvitationNotFound();
  });

  /** `getInvitationByToken`: the emailed token names an active organization's invitation addressed to the caller. */
  const invitationByToken = Effect.fnUntraced(function* (caller: Api.UserPrincipal, token: string) {
    const found = yield* invitations.findByToken(token);
    if (Option.isNone(found)) return yield* new OrganizationErrors.InvitationNotFound();
    yield* activeInvitation(found.value);
    if (!(yield* isInvitee(caller, found.value.email))) {
      return yield* new OrganizationErrors.InvitationNotFound();
    }
    return found.value;
  });

  return {
    creator,
    member,
    teamMember,
    require,
    requireRole,
    requireOnTeam,
    alsoOnTeam,
    invitation,
    upgrade,
    readInvitation,
    invitationByToken,
  };
});
