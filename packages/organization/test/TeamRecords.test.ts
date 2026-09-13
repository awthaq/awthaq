// spec.md's "Teams": the same contract-suite-over-both-layers pattern
// `OrgRoleRecords.test.ts`/`MembershipRecords.test.ts` use, covering both
// `organization_team` and `organization_team_membership` together since
// they're managed by the same `TeamRecords` module.
import { Users } from "@awthaq/core";
import { NodeCrypto } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SqlClient } from "effect/unstable/sql";
import { TeamRecords } from "../src/index.ts";

const MemoryLayer = TeamRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE organization_team (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        organizationId TEXT NOT NULL,
        memberCount INTEGER NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE organization_team_membership (
        id TEXT PRIMARY KEY,
        teamId TEXT NOT NULL,
        userId TEXT NOT NULL,
        createdAt TEXT NOT NULL
      )
    `;
  }),
).pipe(Layer.provide(SqlLive));

const SqlLayer = TeamRecords.layerSql.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const orgId = "org-1";

const suite = (name: string, layer: Layer.Layer<TeamRecords.TeamRecords, unknown, never>): void => {
  describe(name, () => {
    it.effect("createTeam then findTeamById round-trips, memberCount starts at 0", () =>
      Effect.gen(function* () {
        const records = yield* TeamRecords.TeamRecords;
        const team = yield* records.createTeam({ organizationId: orgId, name: "Engineering" });
        assert.strictEqual(team.memberCount, 0);
        const found = yield* records.findTeamById(orgId, team.id);
        assert.isTrue(Option.isSome(found));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("listTeamsByOrganization only returns that organization's teams", () =>
      Effect.gen(function* () {
        const records = yield* TeamRecords.TeamRecords;
        yield* records.createTeam({ organizationId: "org-a", name: "A" });
        yield* records.createTeam({ organizationId: "org-b", name: "B" });
        const listed = yield* records.listTeamsByOrganization("org-a");
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(yield* records.countTeamsByOrganization("org-a"), 1);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("updateTeam renames it; fails for an unknown id", () =>
      Effect.gen(function* () {
        const records = yield* TeamRecords.TeamRecords;
        const team = yield* records.createTeam({ organizationId: orgId, name: "Engineering" });
        const updated = yield* records.updateTeam(orgId, team.id, "Eng");
        assert.strictEqual(updated.name, "Eng");
        const failure = yield* records.updateTeam(orgId, "no-such-id", "x").pipe(Effect.flip);
        assert.strictEqual(failure._tag, "TeamRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("removeTeam deletes the team and cascades its memberships", () =>
      Effect.gen(function* () {
        const records = yield* TeamRecords.TeamRecords;
        const team = yield* records.createTeam({ organizationId: orgId, name: "Engineering" });
        yield* records.addTeamMember({ teamId: team.id, userId: Users.UserId("user-1") });
        yield* records.removeTeam(orgId, team.id);
        const found = yield* records.findTeamById(orgId, team.id);
        assert.isTrue(Option.isNone(found));
        const members = yield* records.listTeamMembers(team.id);
        assert.strictEqual(members.length, 0);
        const failure = yield* records.removeTeam(orgId, team.id).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "TeamRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "removeAllTeamsForOrganization removes every team and membership for that org only",
      () =>
        Effect.gen(function* () {
          const records = yield* TeamRecords.TeamRecords;
          const teamA = yield* records.createTeam({ organizationId: "org-a", name: "A" });
          const teamB = yield* records.createTeam({ organizationId: "org-b", name: "B" });
          yield* records.addTeamMember({ teamId: teamA.id, userId: Users.UserId("user-1") });

          yield* records.removeAllTeamsForOrganization("org-a");
          assert.strictEqual((yield* records.listTeamsByOrganization("org-a")).length, 0);
          assert.strictEqual((yield* records.listTeamsByOrganization("org-b")).length, 1);
          assert.strictEqual((yield* records.listTeamMembers(teamA.id)).length, 0);

          const stillThere = yield* records.findTeamById("org-b", teamB.id);
          assert.isTrue(Option.isSome(stillThere));
        }).pipe(Effect.provide(layer)),
    );

    it.effect("addTeamMember/removeTeamMember maintain memberCount and round-trip membership", () =>
      Effect.gen(function* () {
        const records = yield* TeamRecords.TeamRecords;
        const team = yield* records.createTeam({ organizationId: orgId, name: "Engineering" });
        yield* records.addTeamMember({ teamId: team.id, userId: Users.UserId("user-1") });
        yield* records.addTeamMember({ teamId: team.id, userId: Users.UserId("user-2") });

        const afterAdd = yield* records.findTeamById(orgId, team.id);
        assert.isTrue(Option.isSome(afterAdd));
        if (Option.isSome(afterAdd)) assert.strictEqual(afterAdd.value.memberCount, 2);

        const found = yield* records.findTeamMembership(team.id, Users.UserId("user-1"));
        assert.isTrue(Option.isSome(found));

        yield* records.removeTeamMember(team.id, Users.UserId("user-1"));
        const afterRemove = yield* records.findTeamById(orgId, team.id);
        assert.isTrue(Option.isSome(afterRemove));
        if (Option.isSome(afterRemove)) assert.strictEqual(afterRemove.value.memberCount, 1);

        const failure = yield* records
          .removeTeamMember(team.id, Users.UserId("user-1"))
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "TeamMembershipRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("listTeamsByUser returns only teams, within one org, the user belongs to", () =>
      Effect.gen(function* () {
        const records = yield* TeamRecords.TeamRecords;
        const teamA = yield* records.createTeam({ organizationId: orgId, name: "A" });
        yield* records.createTeam({ organizationId: orgId, name: "B" });
        const teamC = yield* records.createTeam({ organizationId: "other-org", name: "C" });
        yield* records.addTeamMember({ teamId: teamA.id, userId: Users.UserId("user-1") });
        yield* records.addTeamMember({ teamId: teamC.id, userId: Users.UserId("user-1") });

        const teams = yield* records.listTeamsByUser(orgId, Users.UserId("user-1"));
        assert.strictEqual(teams.length, 1);
        assert.strictEqual(teams[0]?.id, teamA.id);
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("TeamRecords (layerMemory)", MemoryLayer);
suite("TeamRecords (layerSql)", SqlLayer);
