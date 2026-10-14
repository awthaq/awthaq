// @awthaq/organization — OrganizationActiveContext
//
// The active organization and team of a session, as a system interface (ADR-EA-040). A session's
// pointers are per session (MTI-001), require membership, and never outlive it (CWM-003): `get`
// re-validates on read and clears a stale pointer for real. These operations are keyed by a session
// reference, not an `Actor`: the session is the identity, and nothing here is an authorization decision
// beyond the membership witness.

import type { Api } from "@awthaq/api";
import { Errors, Users } from "@awthaq/core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ActiveContextRecords from "./ActiveContextRecords.ts";
import * as MembershipRecords from "./MembershipRecords.ts";
import * as OrganizationDirectory from "./OrganizationDirectory.ts";
import * as OrganizationErrors from "./OrganizationErrors.ts";
import * as TeamRecords from "./TeamRecords.ts";

export interface SessionRef {
  readonly sessionId: string;
  readonly userId: Users.UserId;
}

export const sessionOf = (principal: Api.UserPrincipal): SessionRef => ({
  sessionId: principal.sessionId,
  userId: Users.UserId(principal.ref.id),
});

export interface OrganizationActiveContextShape {
  /** CWM-003: re-validated on read; a pointer the user no longer holds is cleared for real. */
  readonly get: (
    session: SessionRef,
  ) => Effect.Effect<ActiveContextRecords.ActiveContextRecord, Errors.StoreUnavailable>;
  /** `None` unsets. The membership is the witness (MTI-001); a suspended organization reads as `MembershipNotFound` (BEH-EA-237). */
  readonly setOrganization: (
    session: SessionRef,
    organizationId: Option.Option<string>,
  ) => Effect.Effect<
    ActiveContextRecords.ActiveContextRecord,
    OrganizationErrors.MembershipNotFound | Errors.StoreUnavailable
  >;
  /** `None` unsets. The team membership is the witness. */
  readonly setTeam: (
    session: SessionRef,
    teamId: Option.Option<string>,
  ) => Effect.Effect<
    ActiveContextRecords.ActiveContextRecord,
    OrganizationErrors.TeamMembershipNotFound | Errors.StoreUnavailable
  >;
  /** The membership in the session's active organization; none set, a suspended organization or a lapsed membership is `NoActiveOrganization`. */
  readonly activeMembership: (
    session: SessionRef,
  ) => Effect.Effect<
    MembershipRecords.MembershipRecord,
    OrganizationErrors.NoActiveOrganization | Errors.StoreUnavailable
  >;
}

export class OrganizationActiveContext extends Context.Service<
  OrganizationActiveContext,
  OrganizationActiveContextShape
>()("awthaq/plugin/organization/ActiveContext") {
  static readonly layer = Layer.effect(
    OrganizationActiveContext,
    Effect.gen(function* () {
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const members = yield* MembershipRecords.MembershipRecords;
      const activeContext = yield* ActiveContextRecords.ActiveContextRecords;
      const teams = yield* TeamRecords.TeamRecords;

      /** The pointers are read directly, so suspension (EP-003) is checked here. */
      const isSuspended = (organizationId: string) =>
        directory
          .find(organizationId)
          .pipe(
            Effect.map((found) => Option.isSome(found) && Option.isSome(found.value.suspendedAt)),
          );

      const get: OrganizationActiveContextShape["get"] = Effect.fnUntraced(function* (session) {
        const existing = yield* activeContext.findBySessionId(session.sessionId);
        if (Option.isNone(existing)) {
          const now = yield* DateTime.now;
          return {
            sessionId: session.sessionId,
            userId: Option.some(session.userId),
            activeOrganizationId: Option.none(),
            activeTeamId: Option.none(),
            updatedAt: now,
          };
        }
        const row = existing.value;
        let stale = false;
        if (Option.isSome(row.activeOrganizationId)) {
          const membership = yield* members.findByUserAndOrg(
            session.userId,
            row.activeOrganizationId.value,
          );
          if (Option.isNone(membership)) {
            yield* activeContext.unsetOrganization(session.sessionId, session.userId);
            yield* activeContext.unsetTeam(session.sessionId, session.userId);
            stale = true;
          }
        }
        if (!stale && Option.isSome(row.activeTeamId)) {
          const onTeam = yield* teams.findTeamMembership(row.activeTeamId.value, session.userId);
          if (Option.isNone(onTeam)) {
            yield* activeContext.unsetTeam(session.sessionId, session.userId);
            stale = true;
          }
        }
        if (!stale) return row;
        const refreshed = yield* activeContext.findBySessionId(session.sessionId);
        return Option.getOrElse(refreshed, () => row);
      });

      const setOrganization: OrganizationActiveContextShape["setOrganization"] = Effect.fnUntraced(
        function* (session, organizationId) {
          if (Option.isNone(organizationId)) {
            return yield* activeContext.unsetOrganization(session.sessionId, session.userId);
          }
          const membership = yield* members.findByUserAndOrg(session.userId, organizationId.value);
          if (Option.isNone(membership) || (yield* isSuspended(organizationId.value))) {
            return yield* new OrganizationErrors.MembershipNotFound();
          }
          // MTI-001: the membership record is the witness the setter requires.
          return yield* activeContext.setOrganization(session.sessionId, membership.value);
        },
      );

      const setTeam: OrganizationActiveContextShape["setTeam"] = Effect.fnUntraced(
        function* (session, teamId) {
          if (Option.isNone(teamId)) {
            return yield* activeContext.unsetTeam(session.sessionId, session.userId);
          }
          const membership = yield* teams.findTeamMembership(teamId.value, session.userId);
          if (Option.isNone(membership))
            return yield* new OrganizationErrors.TeamMembershipNotFound();
          return yield* activeContext.setTeam(session.sessionId, membership.value);
        },
      );

      const activeMembership: OrganizationActiveContextShape["activeMembership"] =
        Effect.fnUntraced(function* (session) {
          const row = yield* activeContext.findBySessionId(session.sessionId);
          const organizationId = Option.flatMap(row, (found) => found.activeOrganizationId);
          if (Option.isNone(organizationId))
            return yield* new OrganizationErrors.NoActiveOrganization();
          if (yield* isSuspended(organizationId.value)) {
            return yield* new OrganizationErrors.NoActiveOrganization();
          }
          const membership = yield* members.findByUserAndOrg(session.userId, organizationId.value);
          if (Option.isNone(membership))
            return yield* new OrganizationErrors.NoActiveOrganization();
          return membership.value;
        });

      return OrganizationActiveContext.of({ get, setOrganization, setTeam, activeMembership });
    }),
  );
}
