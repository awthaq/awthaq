// CSG-001/DRS-002 (.issues/high): `MembershipRecords.deleteAllByUser` and
// `Organization.organizationErasure` (the plugin's `Erasure` contribution, CSG-001).
import { Erasure, Hooks, Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";
import * as InvitationRecords from "../src/InvitationRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as TeamRecords from "../src/TeamRecords.ts";

const MemoryLayer = MembershipRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

describe("MembershipRecords.deleteAllByUser", () => {
  it.effect("removes every membership row for the given user, leaving others untouched", () =>
    Effect.gen(function* () {
      const members = yield* MembershipRecords.MembershipRecords;
      const userA = Users.UserId("user-a");
      const userB = Users.UserId("user-b");
      yield* members.create({ userId: userA, organizationId: "org-1", role: ["owner"] });
      yield* members.create({ userId: userA, organizationId: "org-2", role: ["member"] });
      yield* members.create({ userId: userB, organizationId: "org-1", role: ["member"] });

      yield* members.deleteAllByUser(userA);

      assert.deepStrictEqual(yield* members.listByUser(userA), []);
      const remaining = yield* members.listByUser(userB);
      assert.strictEqual(remaining.length, 1);
    }).pipe(Effect.provide(MemoryLayer)),
  );
});

describe("Organization erasure contribution", () => {
  const TestLayer = Layer.mergeAll(
    Users.layerMemory,
    TeamRecords.layerMemory,
    InvitationRecords.layerMemory,
  ).pipe(
    Layer.provideMerge(MembershipRecords.layerMemory),
    Layer.provideMerge(ActiveContextRecords.layerMemory),
    Layer.provideMerge(Erasure.registryLayer),
    Layer.provideMerge(Hooks.HooksLive),
    Layer.provide(NodeCrypto.layer),
  );

  it.effect(
    "registers itself as `organization` and sweeps memberships, teams, invitations and active context",
    () =>
      Effect.gen(function* () {
        const registry = yield* Erasure.ErasureRegistry;
        const members = yield* MembershipRecords.MembershipRecords;
        const teams = yield* TeamRecords.TeamRecords;
        const invitations = yield* InvitationRecords.InvitationRecords;
        const activeContext = yield* ActiveContextRecords.ActiveContextRecords;
        const mine = Users.UserId("user-mine");
        const theirs = Users.UserId("user-theirs");

        const membership = yield* members.create({
          userId: mine,
          organizationId: "org-1",
          role: ["owner"],
        });
        yield* members.create({ userId: mine, organizationId: "org-2", role: ["member"] });
        const other = yield* members.create({
          userId: theirs,
          organizationId: "org-1",
          role: ["member"],
        });
        yield* activeContext.setOrganization("session-mine", membership);
        yield* activeContext.setOrganization("session-theirs", other);

        const team = yield* teams.createTeam({ organizationId: "org-1", name: "Core" });
        yield* teams.addTeamMember({ teamId: team.id, userId: mine });
        yield* teams.addTeamMember({ teamId: team.id, userId: theirs });

        const invite = (email: string, inviterId: Users.UserId, tokenHash: string) =>
          invitations.create({
            organizationId: "org-2",
            email,
            role: ["member"],
            inviterId,
            tokenHash,
            expiresAt: DateTime.addDuration(DateTime.nowUnsafe(), "1 minute"),
          });
        const sentByMe = yield* invite("friend@example.com", mine, "hash-1");
        const toMe = yield* invite("Mine@Example.com", theirs, "hash-2");
        const unrelated = yield* invite("other@example.com", theirs, "hash-3");

        // `Organization.layer` includes this; built alone here.
        yield* Layer.build(Organization.organizationErasure);
        const contributions = yield* registry.contributions;
        assert.deepStrictEqual(
          contributions.map((c) => c.id),
          ["organization"],
        );
        for (const c of contributions) yield* c.erase({ userId: mine, email: "mine@example.com" });

        assert.deepStrictEqual(yield* members.listByUser(mine), []);
        assert.strictEqual((yield* members.listByUser(theirs)).length, 1);
        assert.isTrue(Option.isNone(yield* activeContext.findBySessionId("session-mine")));
        assert.isTrue(Option.isSome(yield* activeContext.findBySessionId("session-theirs")));
        assert.deepStrictEqual(
          (yield* teams.listTeamMembers(team.id)).map((m) => m.userId),
          [theirs],
        );
        assert.isTrue(Option.isNone(yield* invitations.findById(sentByMe.id)));
        assert.isTrue(Option.isNone(yield* invitations.findById(toMe.id)));
        assert.isTrue(Option.isSome(yield* invitations.findById(unrelated.id)));
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
