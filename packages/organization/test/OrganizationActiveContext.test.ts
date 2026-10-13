// Plan 04 (ADR-EA-040): `OrganizationActiveContext`, a session's active organization and team at its own
// interface. Keyed by a session reference, not an actor: the membership is the only witness (MTI-001), the
// pointers are per session, a suspended organization reads as unavailable (BEH-EA-237) and a lapsed pointer
// is cleared for real on read (CWM-003).
import { Persistence, Users } from "@awthaq/core";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationActiveContext from "../src/OrganizationActiveContext.ts";
import * as OrganizationActor from "../src/OrganizationActor.ts";
import * as OrganizationDirectory from "../src/OrganizationDirectory.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";
import * as OrganizationMemory from "../src/OrganizationMemory.ts";
import * as OrganizationMembers from "../src/OrganizationMembers.ts";
import * as OrganizationSystem from "../src/OrganizationSystem.ts";
import * as OrganizationTeams from "../src/OrganizationTeams.ts";

const teamsOn = {
  enabled: true,
  maximumTeams: Number.POSITIVE_INFINITY,
  maximumMembersPerTeam: Number.POSITIVE_INFINITY,
  allowRemovingAllTeams: true,
};

const Live = OrganizationSystem.layer.pipe(
  Layer.provide(Organization.config({ teams: teamsOn })),
  Layer.provideMerge(OrganizationMemory.layer),
  Layer.provideMerge(Users.layer.pipe(Layer.provide(Persistence.memory))),
  Layer.provideMerge(Mailer.layerMemory),
  Layer.provideMerge(TestAuth.memoryFoundation),
  Layer.provideMerge(SqlTransaction.layerNoop),
  Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
);

const application = OrganizationActor.application("OrganizationActiveContext.test");
const owner = Users.UserId("owner-1");
const session = (
  sessionId: string,
  userId: Users.UserId = owner,
): OrganizationActiveContext.SessionRef => ({
  sessionId,
  userId,
});

const flipTag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error._tag),
  );

const arrange = Effect.gen(function* () {
  const directory = yield* OrganizationDirectory.OrganizationDirectory;
  const active = yield* OrganizationActiveContext.OrganizationActiveContext;
  const org = yield* directory.create(application, { owner, name: "Acme", slug: "acme" });
  return { org, active, directory };
});

describe("OrganizationActiveContext", () => {
  it.effect("setOrganization needs membership, is per session, and None unsets", () =>
    Effect.gen(function* () {
      const { org, active } = yield* arrange;
      assert.strictEqual(
        yield* flipTag(
          active.setOrganization(session("s-out", Users.UserId("outsider")), Option.some(org.id)),
        ),
        "MembershipNotFound",
      );
      yield* active.setOrganization(session("s1"), Option.some(org.id));
      assert.deepStrictEqual(
        (yield* active.get(session("s1"))).activeOrganizationId,
        Option.some(org.id),
      );
      assert.deepStrictEqual(
        (yield* active.get(session("s2"))).activeOrganizationId,
        Option.none(),
      );
      yield* active.setOrganization(session("s1"), Option.none());
      assert.deepStrictEqual(
        (yield* active.get(session("s1"))).activeOrganizationId,
        Option.none(),
      );
    }).pipe(Effect.provide(Live)),
  );

  it.effect(
    "activeMembership is NoActiveOrganization with none set, and while the organization is suspended",
    () =>
      Effect.gen(function* () {
        const { org, active, directory } = yield* arrange;
        assert.strictEqual(
          yield* flipTag(active.activeMembership(session("s1"))),
          "NoActiveOrganization",
        );
        yield* active.setOrganization(session("s1"), Option.some(org.id));
        assert.deepStrictEqual((yield* active.activeMembership(session("s1"))).role, ["owner"]);
        yield* directory.suspend(OrganizationActor.platformAdmin(Users.UserId("admin")), {
          organizationId: org.id,
        });
        assert.strictEqual(
          yield* flipTag(active.activeMembership(session("s1"))),
          "NoActiveOrganization",
        );
        assert.strictEqual(
          yield* flipTag(active.setOrganization(session("s2"), Option.some(org.id))),
          "MembershipNotFound",
        );
      }).pipe(Effect.provide(Live)),
  );

  it.effect("setTeam needs team membership", () =>
    Effect.gen(function* () {
      const { org, active } = yield* arrange;
      const teams = yield* OrganizationTeams.OrganizationTeams;
      const { team } = yield* teams.create(application, {
        organizationId: org.id,
        name: "Eng",
        initialMembers: [owner],
      });
      assert.strictEqual(
        yield* flipTag(
          active.setTeam(session("s-out", Users.UserId("outsider")), Option.some(team.id)),
        ),
        "TeamMembershipNotFound",
      );
      yield* active.setTeam(session("s1"), Option.some(team.id));
      assert.deepStrictEqual((yield* active.get(session("s1"))).activeTeamId, Option.some(team.id));
      yield* active.setTeam(session("s1"), Option.none());
      assert.deepStrictEqual((yield* active.get(session("s1"))).activeTeamId, Option.none());
    }).pipe(Effect.provide(Live)),
  );

  it.effect(
    "get re-validates: a pointer at an organization the user left reads as cleared, and is cleared for real",
    () =>
      Effect.gen(function* () {
        const { org, active } = yield* arrange;
        const records = yield* MembershipRecords.MembershipRecords;
        const members = yield* OrganizationMembers.OrganizationMembers;
        yield* members.add(application, {
          organizationId: org.id,
          userId: Users.UserId("u2"),
          role: ["member"],
          bound: OrganizationActor.Bound.Unbounded(),
        });
        const u2 = session("s2", Users.UserId("u2"));
        yield* active.setOrganization(u2, Option.some(org.id));
        // The membership goes away around the module (a row removed by hand), so no cascade ran.
        yield* records.remove(Users.UserId("u2"), org.id);
        assert.deepStrictEqual((yield* active.get(u2)).activeOrganizationId, Option.none());
        assert.deepStrictEqual((yield* active.get(u2)).activeOrganizationId, Option.none());
      }).pipe(Effect.provide(Live)),
  );
});
