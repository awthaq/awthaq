// CSG-005: `Organization.organizationExport`, the plugin's section of the data-subject
// export — memberships, teams, invitations sent and received, never a third party's address.
import { DataExport, Hooks, Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as InvitationRecords from "../src/InvitationRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as TeamRecords from "../src/TeamRecords.ts";

const TestLayer = Layer.mergeAll(
  MembershipRecords.layerMemory,
  TeamRecords.layerMemory,
  InvitationRecords.layerMemory,
).pipe(Layer.provideMerge(Hooks.HooksLive), Layer.provide(NodeCrypto.layer));

describe("Organization export contribution", () => {
  it.effect("registers as `organization` and collects only the subject's own rows", () =>
    Effect.gen(function* () {
      const registry = yield* DataExport.DataExportRegistry;
      const members = yield* MembershipRecords.MembershipRecords;
      const teams = yield* TeamRecords.TeamRecords;
      const invitations = yield* InvitationRecords.InvitationRecords;
      const mine = Users.UserId("user-mine");
      const theirs = Users.UserId("user-theirs");

      yield* members.create({ userId: mine, organizationId: "org-1", role: ["owner"] });
      yield* members.create({ userId: theirs, organizationId: "org-1", role: ["member"] });
      yield* members.create({ userId: theirs, organizationId: "org-9", role: ["member"] });
      const team = yield* teams.createTeam({ organizationId: "org-1", name: "Core" });
      yield* teams.addTeamMember({ teamId: team.id, userId: mine });
      const invite = (email: string, inviterId: Users.UserId, tokenHash: string) =>
        invitations.create({
          organizationId: "org-1",
          email,
          role: ["member"],
          inviterId,
          tokenHash,
          expiresAt: DateTime.addDuration(DateTime.nowUnsafe(), "1 day"),
        });
      yield* invite("friend@example.com", mine, "hash-1");
      yield* invite("mine@example.com", theirs, "hash-2");
      yield* invite("other@example.com", theirs, "hash-3");

      yield* Layer.build(Organization.organizationExport);
      const contributions = yield* registry.contributions;
      assert.deepStrictEqual(
        contributions.map((c) => c.id),
        ["organization"],
      );
      const section = yield* contributions[0]!.collect({
        userId: mine,
        email: "mine@example.com",
      });

      // Dates are checked to exist by the schema; the rest is compared exactly.
      const Invitation = Schema.Struct({
        organizationId: Schema.String,
        role: Schema.Array(Schema.String),
        status: Schema.String,
        createdAt: Schema.String,
        expiresAt: Schema.String,
      });
      const shape = Schema.decodeUnknownSync(
        Schema.Struct({
          memberships: Schema.Array(
            Schema.Struct({
              organizationId: Schema.String,
              role: Schema.Array(Schema.String),
              createdAt: Schema.String,
            }),
          ),
          teams: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              organizationId: Schema.String,
              name: Schema.String,
            }),
          ),
          invitationsSent: Schema.Array(Invitation),
          invitationsReceived: Schema.Array(Invitation),
        }),
      )(section);
      assert.deepStrictEqual(
        shape.memberships.map((m) => [m.organizationId, m.role]),
        [["org-1", ["owner"]]],
      );
      assert.deepStrictEqual(shape.teams, [{ id: team.id, organizationId: "org-1", name: "Core" }]);
      assert.deepStrictEqual(
        shape.invitationsSent.map((i) => [i.organizationId, i.role, i.status]),
        [["org-1", ["member"], "pending"]],
      );
      assert.deepStrictEqual(
        shape.invitationsReceived.map((i) => [i.organizationId, i.role, i.status]),
        [["org-1", ["member"], "pending"]],
      );
      const text = JSON.stringify(section);
      // no third party's address, no other user's id
      assert.notInclude(text, "friend@example.com");
      assert.notInclude(text, "other@example.com");
      assert.notInclude(text, "user-theirs");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
