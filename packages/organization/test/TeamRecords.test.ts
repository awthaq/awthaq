// spec.md's "Teams": the same contract-suite-over-both-layers pattern
// `OrgRoleRecords.test.ts`/`MembershipRecords.test.ts` use, covering both
// `organization_team` and `organization_team_membership` together since
// they're managed by the same `TeamRecords` module. `layerSql` here is
// migrated via `Organization.Organization`'s own real `migrations`
// (`Migrations.run`, `@awthaq/core`) rather than hand-rolled inline
// `CREATE TABLE`s — BAM-002 (.issues/high) verification, the same
// `packages/jwt/test/RevocationStore.test.ts` establishes.
import { Migrations, Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Organization from "../src/Organization.ts";
import * as TeamRecords from "../src/TeamRecords.ts";

const MemoryLayer = TeamRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
  Layer.provide(SqlLive),
);

const SqlLayer = TeamRecords.layerSql.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

// The same records layer over an *unmigrated* database, for the backfill test.
const LegacySqlLayer = TeamRecords.layerSql.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(SqlLive),
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

    // ---- OHS-001 (wayfinder ticket 34): parentId adjacency + closure read model ----
    const names = (teams: ReadonlyArray<TeamRecords.TeamRecord>) => teams.map((t) => t.name);
    const seedTree = Effect.gen(function* () {
      const records = yield* TeamRecords.TeamRecords;
      const a = yield* records.createTeam({ organizationId: orgId, name: "A" });
      const b = yield* records.createTeam({ organizationId: orgId, name: "B", parentId: a.id });
      const c = yield* records.createTeam({ organizationId: orgId, name: "C", parentId: b.id });
      const d = yield* records.createTeam({ organizationId: orgId, name: "D" });
      return { records, a, b, c, d };
    });

    it.effect("nested creates expose parentId and single-lookup ancestor/descendant/subtree reads", () =>
      Effect.gen(function* () {
        const { records, a, b, c } = yield* seedTree;
        assert.deepStrictEqual(a.parentId, Option.none());
        assert.deepStrictEqual(b.parentId, Option.some(a.id));
        // Ancestors and descendants are nearest-first; neither includes the team itself.
        assert.deepStrictEqual(names(yield* records.getAncestors(orgId, c.id)), ["B", "A"]);
        assert.deepStrictEqual(names(yield* records.getDescendants(orgId, a.id)), ["B", "C"]);
        assert.deepStrictEqual(names(yield* records.getAncestors(orgId, a.id)), []);
        assert.deepStrictEqual(names(yield* records.getDescendants(orgId, c.id)), []);
        // A subtree is the team itself, then its descendants.
        assert.deepStrictEqual(names(yield* records.getSubtree(orgId, b.id)), ["B", "C"]);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("a parent from another organization is refused (TeamRecordNotFound)", () =>
      Effect.gen(function* () {
        const records = yield* TeamRecords.TeamRecords;
        const foreign = yield* records.createTeam({ organizationId: "other-org", name: "Foreign" });
        const failure = yield* records
          .createTeam({ organizationId: orgId, name: "Child", parentId: foreign.id })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "TeamRecordNotFound");
        const missing = yield* records
          .createTeam({ organizationId: orgId, name: "Child", parentId: "no-such-team" })
          .pipe(Effect.flip);
        assert.strictEqual(missing._tag, "TeamRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("moveTeam re-parents a whole subtree, and to the root with none", () =>
      Effect.gen(function* () {
        const { records, a, b, c, d } = yield* seedTree;
        const moved = yield* records.moveTeam({
          organizationId: orgId,
          id: b.id,
          parentId: Option.some(d.id),
        });
        assert.deepStrictEqual(moved.parentId, Option.some(d.id));
        assert.deepStrictEqual(names(yield* records.getAncestors(orgId, c.id)), ["B", "D"]);
        assert.deepStrictEqual(names(yield* records.getDescendants(orgId, a.id)), []);
        assert.deepStrictEqual(names(yield* records.getDescendants(orgId, d.id)), ["B", "C"]);

        yield* records.moveTeam({ organizationId: orgId, id: b.id, parentId: Option.none() });
        assert.deepStrictEqual(names(yield* records.getAncestors(orgId, c.id)), ["B"]);
        assert.deepStrictEqual(names(yield* records.getDescendants(orgId, d.id)), []);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("moving a team under itself or its own descendant fails TeamHierarchyCycle", () =>
      Effect.gen(function* () {
        const { records, a, b, c } = yield* seedTree;
        for (const parentId of [a.id, b.id, c.id]) {
          const failure = yield* records
            .moveTeam({ organizationId: orgId, id: a.id, parentId: Option.some(parentId) })
            .pipe(Effect.flip);
          assert.strictEqual(failure._tag, "TeamHierarchyCycle");
        }
        // Nothing moved.
        assert.deepStrictEqual(names(yield* records.getDescendants(orgId, a.id)), ["B", "C"]);
        const unknown = yield* records
          .moveTeam({ organizationId: orgId, id: "no-such", parentId: Option.none() })
          .pipe(Effect.flip);
        assert.strictEqual(unknown._tag, "TeamRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("removeTeam refuses a team with children (TeamHasChildren); a leaf removes cleanly", () =>
      Effect.gen(function* () {
        const { records, a, b, c } = yield* seedTree;
        const failure = yield* records.removeTeam(orgId, b.id).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "TeamHasChildren");
        yield* records.removeTeam(orgId, c.id);
        assert.deepStrictEqual(names(yield* records.getDescendants(orgId, a.id)), ["B"]);
        yield* records.removeTeam(orgId, b.id);
        assert.deepStrictEqual(names(yield* records.getDescendants(orgId, a.id)), []);
      }).pipe(Effect.provide(layer)),
    );

    // OHS-003: one membership per (teamId, userId); memberCount can never over-count.
    it.effect(
      "adding the same user to a team twice fails TeamMembershipRecordAlreadyExists and memberCount stays 1",
      () =>
        Effect.gen(function* () {
          const records = yield* TeamRecords.TeamRecords;
          const team = yield* records.createTeam({ organizationId: orgId, name: "Engineering" });
          yield* records.addTeamMember({ teamId: team.id, userId: Users.UserId("user-1") });
          const failure = yield* records
            .addTeamMember({ teamId: team.id, userId: Users.UserId("user-1") })
            .pipe(Effect.flip);
          assert.strictEqual(failure._tag, "TeamMembershipRecordAlreadyExists");
          const after = yield* records.findTeamById(orgId, team.id);
          assert.isTrue(Option.isSome(after));
          if (Option.isSome(after)) assert.strictEqual(after.value.memberCount, 1);
          assert.strictEqual((yield* records.listTeamMembers(team.id)).length, 1);
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

// OHS-002: each multi-statement layerSql op commits or rolls back as one unit.
// A trigger makes one statement of the op fail for real, so the assertion is
// about what the database holds afterwards, not about a mock.
describe("TeamRecords (layerSql) atomicity", () => {
  it.effect("removeTeam deletes the team and its memberships atomically", () =>
    Effect.gen(function* () {
      const records = yield* TeamRecords.TeamRecords;
      const sql = yield* SqlClient.SqlClient;
      const team = yield* records.createTeam({ organizationId: orgId, name: "Engineering" });
      yield* records.addTeamMember({ teamId: team.id, userId: Users.UserId("user-1") });
      yield* sql.unsafe(
        `CREATE TRIGGER fail_team_membership_delete BEFORE DELETE ON organization_team_membership
         BEGIN SELECT RAISE(ABORT, 'injected'); END`,
      );
      const exit = yield* Effect.exit(records.removeTeam(orgId, team.id));
      assert.isTrue(Exit.isFailure(exit));
      // The team row's own DELETE ran first; it must have been rolled back.
      const rows = yield* sql`SELECT id FROM organization_team WHERE id = ${team.id}`;
      assert.strictEqual(rows.length, 1);
    }).pipe(Effect.provide(SqlLayer)),
  );

  it.effect("addTeamMember inserts the row and bumps memberCount atomically", () =>
    Effect.gen(function* () {
      const records = yield* TeamRecords.TeamRecords;
      const sql = yield* SqlClient.SqlClient;
      const team = yield* records.createTeam({ organizationId: orgId, name: "Engineering" });
      yield* sql.unsafe(
        `CREATE TRIGGER fail_team_count BEFORE UPDATE ON organization_team
         BEGIN SELECT RAISE(ABORT, 'injected'); END`,
      );
      const exit = yield* Effect.exit(
        records.addTeamMember({ teamId: team.id, userId: Users.UserId("user-1") }),
      );
      assert.isTrue(Exit.isFailure(exit));
      const rows =
        yield* sql`SELECT id FROM organization_team_membership WHERE teamId = ${team.id}`;
      assert.strictEqual(rows.length, 0);
    }).pipe(Effect.provide(SqlLayer)),
  );

  it.effect("removeAllTeamsForOrganization deletes memberships and teams atomically", () =>
    Effect.gen(function* () {
      const records = yield* TeamRecords.TeamRecords;
      const sql = yield* SqlClient.SqlClient;
      const team = yield* records.createTeam({ organizationId: "org-x", name: "X" });
      yield* records.addTeamMember({ teamId: team.id, userId: Users.UserId("user-1") });
      yield* sql.unsafe(
        `CREATE TRIGGER fail_team_delete BEFORE DELETE ON organization_team
         BEGIN SELECT RAISE(ABORT, 'injected'); END`,
      );
      const exit = yield* Effect.exit(records.removeAllTeamsForOrganization("org-x"));
      assert.isTrue(Exit.isFailure(exit));
      const rows =
        yield* sql`SELECT id FROM organization_team_membership WHERE teamId = ${team.id}`;
      assert.strictEqual(rows.length, 1);
    }).pipe(Effect.provide(SqlLayer)),
  );
});

// OHS-001: the closure table itself — what makes the reads single indexed lookups.
describe("TeamRecords (layerSql) closure table", () => {
  const closureCount = (sql: SqlClient.SqlClient) =>
    sql
      .unsafe("SELECT COUNT(*) AS n FROM organization_team_closure")
      .pipe(
        Effect.map((rows) => {
          const first = rows[0];
          return typeof first === "object" && first !== null && "n" in first ? Number(first.n) : -1;
        }),
      );

  it.effect("closure rows track nested creates, moves, removals and organization cascades", () =>
    Effect.gen(function* () {
      const records = yield* TeamRecords.TeamRecords;
      const sql = yield* SqlClient.SqlClient;
      const a = yield* records.createTeam({ organizationId: orgId, name: "A" });
      const b = yield* records.createTeam({ organizationId: orgId, name: "B", parentId: a.id });
      const c = yield* records.createTeam({ organizationId: orgId, name: "C", parentId: b.id });
      // 3 self rows + (A,B) (A,C) (B,C)
      assert.strictEqual(yield* closureCount(sql), 6);

      yield* records.moveTeam({ organizationId: orgId, id: b.id, parentId: Option.none() });
      // A alone, B->C: 3 self + (B,C)
      assert.strictEqual(yield* closureCount(sql), 4);

      yield* records.removeTeam(orgId, c.id);
      assert.strictEqual(yield* closureCount(sql), 2);

      yield* records.removeAllTeamsForOrganization(orgId);
      assert.strictEqual(yield* closureCount(sql), 0);
    }).pipe(Effect.provide(SqlLayer)),
  );

  it.effect("the hierarchy migration backfills a closure self-row for every pre-existing team", () =>
    Effect.gen(function* () {
      const all = Organization.Organization.migrations;
      const at = all.findIndex((m) => m.name === "organization_team_hierarchy");
      assert.isTrue(at > 0);
      const sql = yield* SqlClient.SqlClient;
      // Schema as it stood before the hierarchy, with a team written under it.
      yield* Migrations.run(all.slice(0, at));
      yield* sql.unsafe(
        `INSERT INTO organization_team (id, name, organizationId, memberCount, createdAt, updatedAt)
         VALUES ('legacy-1', 'Legacy', 'org-1', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      );
      yield* Migrations.run(all);
      const records = yield* TeamRecords.TeamRecords;
      const found = yield* records.findTeamById("org-1", "legacy-1");
      assert.isTrue(Option.isSome(found) && Option.isNone(found.value.parentId));
      assert.strictEqual(yield* closureCount(sql), 1);
      // ... and it can be a parent straight away.
      const child = yield* records.createTeam({ organizationId: "org-1", name: "Kid", parentId: "legacy-1" });
      assert.deepStrictEqual(
        (yield* records.getAncestors("org-1", child.id)).map((t) => t.name),
        ["Legacy"],
      );
    }).pipe(Effect.provide(LegacySqlLayer)),
  );
});
