// Plan 25 ticket 11 (ADR-EA-041 decision 9): `TeamRecords`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`. Every write to an organization's team forest takes its lock on SQL,
// so two crossing moves cannot make a cycle (plan 24 C1) and a parent cannot vanish under a create (C2). The last
// team (`keepOne`), `maximumTeams` and `maximumMembersPerTeam` (`within`) are decided inside the write; a member
// count never goes negative (C3); teams list by `(createdAt, id)` (R3).
import { Users } from "@awthaq/core";
import { RecordsContract, type TestAuth, TestSql } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as TeamRecords from "../../src/TeamRecords.ts";
import { ambientOrganization, grant } from "../support.ts";

const orgId = "org-1";

const exitTag = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? "ok"
    : Option.match(Exit.findErrorOption(exit), { onNone: () => "defect", onSome: (e) => e._tag });

const closureCount = (sql: SqlClient.SqlClient) =>
  sql.unsafe("SELECT COUNT(*) AS n FROM organization_team_closure").pipe(
    Effect.map((rows) => {
      const first = rows[0];
      return typeof first === "object" && first !== null && "n" in first ? Number(first.n) : -1;
    }),
  );

let isolationCounter = 0;
interface Row {
  /** The child team: the row under test. */
  readonly id: string;
  readonly parentId: string;
  readonly organizationId: string;
  readonly userId: Users.UserId;
}
const orgOf = (row: Row, as: "owner" | "other") =>
  as === "owner" ? row.organizationId : "another-organization";

const insertRow = Effect.gen(function* () {
  const records = yield* TeamRecords.TeamRecords;
  isolationCounter += 1;
  const organizationId = yield* ambientOrganization;
  const parent = yield* records.createTeam({ organizationId, name: `parent ${isolationCounter}` });
  const child = yield* records.createTeam({
    organizationId,
    name: `child ${isolationCounter}`,
    parentId: parent.id,
  });
  const userId = Users.UserId(`isolation-user-${isolationCounter}`);
  yield* records.addTeamMember({ teamId: child.id, userId });
  return { id: child.id, parentId: parent.id, organizationId, userId };
});

const using = <A, E, R>(use: (records: TeamRecords.TeamRecordsShape) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(TeamRecords.TeamRecords, use);
const notFound = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.as(true),
    Effect.catchTags({
      TeamRecordNotFound: () => Effect.succeed(false),
      TeamMembershipRecordNotFound: () => Effect.succeed(false),
    }),
  );
const hasTeam = (row: Row) =>
  using((records) => Effect.map(records.findTeamById(row.organizationId, row.id), Option.isSome));
const hasMembership = (row: Row) =>
  using((records) => Effect.map(records.findTeamMembership(row.id, row.userId), Option.isSome));

const derivedElsewhere = (table: string) => ({
  derived: `operates on ${table}; classified in that table's case`,
});

type Methods = {
  readonly [K in keyof TeamRecords.TeamRecordsShape]: TestAuth.MethodClass<
    Row,
    TeamRecords.TeamRecords
  >;
};

const teamMethods: Methods = {
  createTeam: { insert: true },
  findTeamById: {
    keyed: {
      run: (row, as) =>
        using((records) => Effect.map(records.findTeamById(orgOf(row, as), row.id), Option.isSome)),
    },
  },
  findTeamByIdAnyOrg: {
    crossTenant: {
      run: (row) =>
        using((records) => Effect.map(records.findTeamByIdAnyOrg(grant, row.id), Option.isSome)),
    },
  },
  listTeamsByOrganization: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          Effect.map(records.listTeamsByOrganization(orgOf(row, as)), (rows) =>
            rows.some((team) => team.id === row.id),
          ),
        ),
    },
  },
  countTeamsByOrganization: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          Effect.map(records.countTeamsByOrganization(orgOf(row, as)), (count) => count > 0),
        ),
    },
  },
  updateTeam: {
    keyed: {
      run: (row, as) =>
        using((records) => notFound(records.updateTeam(orgOf(row, as), row.id, "Renamed"))),
    },
  },
  moveTeam: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          notFound(
            records.moveTeam({
              organizationId: orgOf(row, as),
              id: row.id,
              parentId: Option.none(),
            }),
          ),
        ),
    },
  },
  getAncestors: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          Effect.map(records.getAncestors(orgOf(row, as), row.id), (rows) =>
            rows.some((team) => team.id === row.parentId),
          ),
        ),
    },
  },
  getDescendants: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          Effect.map(records.getDescendants(orgOf(row, as), row.parentId), (rows) =>
            rows.some((team) => team.id === row.id),
          ),
        ),
    },
  },
  getSubtree: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          Effect.map(records.getSubtree(orgOf(row, as), row.parentId), (rows) =>
            rows.some((team) => team.id === row.id),
          ),
        ),
    },
  },
  removeTeam: {
    keyed: {
      run: (row, as) => using((records) => notFound(records.removeTeam(orgOf(row, as), row.id))),
    },
  },
  removeAllTeamsForOrganization: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          Effect.gen(function* () {
            const before = yield* hasTeam(row);
            yield* records.removeAllTeamsForOrganization(orgOf(row, as));
            return before && !(yield* hasTeam(row));
          }),
        ),
    },
  },
  addTeamMember: derivedElsewhere("organization_team_membership"),
  updateTeamMemberRole: derivedElsewhere("organization_team_membership"),
  removeTeamMember: derivedElsewhere("organization_team_membership"),
  removeUserFromOrganizationTeams: derivedElsewhere("organization_team_membership"),
  removeUserFromAllTeams: derivedElsewhere("organization_team_membership"),
  findTeamMembership: derivedElsewhere("organization_team_membership"),
  listTeamMembers: derivedElsewhere("organization_team_membership"),
  listTeamsByUser: derivedElsewhere("organization_team_membership"),
};

const membershipMethods: Methods = {
  createTeam: { insert: true },
  findTeamById: derivedElsewhere("organization_team"),
  findTeamByIdAnyOrg: derivedElsewhere("organization_team"),
  listTeamsByOrganization: derivedElsewhere("organization_team"),
  countTeamsByOrganization: derivedElsewhere("organization_team"),
  updateTeam: derivedElsewhere("organization_team"),
  moveTeam: derivedElsewhere("organization_team"),
  getAncestors: derivedElsewhere("organization_team"),
  getDescendants: derivedElsewhere("organization_team"),
  getSubtree: derivedElsewhere("organization_team"),
  removeTeam: derivedElsewhere("organization_team"),
  removeAllTeamsForOrganization: derivedElsewhere("organization_team"),
  addTeamMember: { insert: true },
  updateTeamMemberRole: {
    derived:
      "keyed by a team id the caller already resolved through an organization-keyed team read",
  },
  removeTeamMember: {
    derived:
      "keyed by a team id the caller already resolved through an organization-keyed team read",
  },
  removeUserFromOrganizationTeams: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          Effect.gen(function* () {
            const before = yield* hasMembership(row);
            yield* records.removeUserFromOrganizationTeams(orgOf(row, as), row.userId);
            return before && !(yield* hasMembership(row));
          }),
        ),
    },
  },
  removeUserFromAllTeams: {
    crossTenant: {
      run: (row) =>
        using((records) =>
          Effect.gen(function* () {
            const before = yield* hasMembership(row);
            yield* records.removeUserFromAllTeams(grant, row.userId);
            return before && !(yield* hasMembership(row));
          }),
        ),
    },
  },
  findTeamMembership: {
    derived:
      "keyed by a team id the caller already resolved through an organization-keyed team read",
  },
  listTeamMembers: {
    derived:
      "keyed by a team id the caller already resolved through an organization-keyed team read",
  },
  listTeamsByUser: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          Effect.map(records.listTeamsByUser(orgOf(row, as), row.userId), (rows) =>
            rows.some((team) => team.id === row.id),
          ),
        ),
    },
  },
};

const viaHierarchy = {
  derived:
    "closure rows are written and read only through the hierarchy methods, keyed by team ids resolved under their organization",
};

const closureMethods: Methods = {
  createTeam: { insert: true },
  findTeamById: viaHierarchy,
  findTeamByIdAnyOrg: viaHierarchy,
  listTeamsByOrganization: viaHierarchy,
  countTeamsByOrganization: viaHierarchy,
  updateTeam: viaHierarchy,
  moveTeam: viaHierarchy,
  getAncestors: viaHierarchy,
  getDescendants: viaHierarchy,
  getSubtree: viaHierarchy,
  removeTeam: viaHierarchy,
  removeAllTeamsForOrganization: viaHierarchy,
  addTeamMember: viaHierarchy,
  updateTeamMemberRole: viaHierarchy,
  removeTeamMember: viaHierarchy,
  removeUserFromOrganizationTeams: viaHierarchy,
  removeUserFromAllTeams: viaHierarchy,
  findTeamMembership: viaHierarchy,
  listTeamMembers: viaHierarchy,
  listTeamsByUser: viaHierarchy,
};

const names = (teams: ReadonlyArray<TeamRecords.TeamRecord>) => teams.map((t) => t.name);
const seedTree = Effect.gen(function* () {
  const records = yield* TeamRecords.TeamRecords;
  const a = yield* records.createTeam({ organizationId: orgId, name: "A" });
  const b = yield* records.createTeam({ organizationId: orgId, name: "B", parentId: a.id });
  const c = yield* records.createTeam({ organizationId: orgId, name: "C", parentId: b.id });
  const d = yield* records.createTeam({ organizationId: orgId, name: "D" });
  return { records, a, b, c, d };
});

const team = (name: string, parentId?: string) =>
  Effect.flatMap(TeamRecords.TeamRecords, (records) =>
    records.createTeam({ organizationId: orgId, name, parentId }),
  );

export const teamRecords = RecordsContract.suite(TeamRecords.TeamRecords, {
  operations: {
    createTeam: {
      atomic: [
        {
          name: "createTeam then findTeamById round-trips, memberCount starts at 0",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const team = yield* records.createTeam({ organizationId: orgId, name: "Engineering" });
            assert.strictEqual(team.memberCount, 0);
            const found = yield* records.findTeamById(orgId, team.id);
            assert.isTrue(Option.isSome(found));
          }),
        },
        {
          name: "a parent from another organization is refused (TeamRecordNotFound)",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const foreign = yield* records.createTeam({
              organizationId: "other-org",
              name: "Foreign",
            });
            const failure = yield* records
              .createTeam({ organizationId: orgId, name: "Child", parentId: foreign.id })
              .pipe(Effect.flip);
            assert.strictEqual(failure._tag, "TeamRecordNotFound");
            const missing = yield* records
              .createTeam({ organizationId: orgId, name: "Child", parentId: "no-such-team" })
              .pipe(Effect.flip);
            assert.strictEqual(missing._tag, "TeamRecordNotFound");
          }),
        },
        {
          name: "within refuses at maximumTeams (TeamRecords/LimitReached) and stores nothing",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            yield* records.createTeam({ organizationId: orgId, name: "A" }, { within: 2 });
            yield* records.createTeam({ organizationId: orgId, name: "B" }, { within: 2 });
            const refused = yield* Effect.flip(
              records.createTeam({ organizationId: orgId, name: "C" }, { within: 2 }),
            );
            assert.strictEqual(refused._tag, "TeamRecords/LimitReached");
            assert.strictEqual(yield* records.countTeamsByOrganization(orgId), 2);
          }),
        },
      ],
      race: [
        {
          name: "8 creates racing at within - 1 store exactly one",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            yield* team("existing");
            const outcomes = yield* Effect.all(
              Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) =>
                Effect.map(
                  Effect.exit(
                    records.createTeam({ organizationId: orgId, name: `t${n}` }, { within: 2 }),
                  ),
                  exitTag,
                ),
              ),
              { concurrency: "unbounded" },
            );
            assert.strictEqual(outcomes.filter((tag) => tag === "ok").length, 1);
            assert.strictEqual(yield* records.countTeamsByOrganization(orgId), 2);
          }),
        },
        {
          name: "creating children of a parent racing its removal never leaves an orphan (plan 24 C2)",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            for (let round = 0; round < RecordsContract.CONCURRENCY; round++) {
              const parent = yield* team(`parent-${round}`);
              yield* Effect.all(
                [
                  Effect.exit(records.removeTeam(orgId, parent.id)),
                  Effect.exit(team(`child-${round}`, parent.id)),
                ],
                { concurrency: "unbounded" },
              );
              const parentLeft = Option.isSome(yield* records.findTeamById(orgId, parent.id));
              const children = (yield* records.listTeamsByOrganization(orgId)).filter(
                (row) => Option.isSome(row.parentId) && row.parentId.value === parent.id,
              );
              assert.isTrue(parentLeft || children.length === 0, `round ${round}: an orphan`);
            }
          }),
        },
      ],
    },
    findTeamById: {
      read: [
        {
          name: "finds a team only in its own organization",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const created = yield* team("A");
            assert.isTrue(Option.isSome(yield* records.findTeamById(orgId, created.id)));
            assert.isTrue(Option.isNone(yield* records.findTeamById("org-other", created.id)));
          }),
        },
      ],
    },
    findTeamByIdAnyOrg: {
      read: [
        {
          name: "resolves a team from its id alone, with the witness",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const created = yield* team("A");
            const found = yield* records.findTeamByIdAnyOrg(grant, created.id);
            assert.isTrue(Option.isSome(found) && found.value.organizationId === orgId);
            assert.isTrue(Option.isNone(yield* records.findTeamByIdAnyOrg(grant, "missing")));
          }),
        },
      ],
    },
    listTeamsByOrganization: {
      read: [
        {
          name: "listTeamsByOrganization only returns that organization's teams",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            yield* records.createTeam({ organizationId: "org-a", name: "A" });
            yield* records.createTeam({ organizationId: "org-b", name: "B" });
            const listed = yield* records.listTeamsByOrganization("org-a");
            assert.strictEqual(listed.length, 1);
            assert.strictEqual(yield* records.countTeamsByOrganization("org-a"), 1);
          }),
        },
        {
          name: "orders by (createdAt, id) (plan 24 R3)",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const first = yield* team("first");
            yield* TestClock.adjust("1 millis");
            const tied = [yield* team("tied-a"), yield* team("tied-b")];
            const listed = (yield* records.listTeamsByOrganization(orgId)).map((row) => row.id);
            assert.deepStrictEqual(listed, [first.id, ...tied.map((row) => row.id).sort()]);
          }),
        },
      ],
    },
    countTeamsByOrganization: {
      read: [
        {
          name: "counts only that organization's teams",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            yield* team("A");
            yield* team("B");
            yield* records.createTeam({ organizationId: "org-other", name: "C" });
            assert.strictEqual(yield* records.countTeamsByOrganization(orgId), 2);
          }),
        },
      ],
    },
    updateTeam: {
      write: [
        {
          name: "updateTeam renames it; fails for an unknown id",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const team = yield* records.createTeam({ organizationId: orgId, name: "Engineering" });
            const updated = yield* records.updateTeam(orgId, team.id, "Eng");
            assert.strictEqual(updated.name, "Eng");
            const failure = yield* records.updateTeam(orgId, "no-such-id", "x").pipe(Effect.flip);
            assert.strictEqual(failure._tag, "TeamRecordNotFound");
          }),
        },
      ],
    },
    moveTeam: {
      atomic: [
        {
          name: "moveTeam re-parents a whole subtree, and to the root with none",
          run: Effect.gen(function* () {
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
          }),
        },
        {
          name: "moving a team under itself or its own descendant fails TeamHierarchyCycle",
          run: Effect.gen(function* () {
            const { records, a, b, c } = yield* seedTree;
            for (const parentId of [a.id, b.id, c.id]) {
              const failure = yield* records
                .moveTeam({ organizationId: orgId, id: a.id, parentId: Option.some(parentId) })
                .pipe(Effect.flip);
              assert.strictEqual(failure._tag, "TeamRecords/HierarchyCycle");
            }
            // Nothing moved.
            assert.deepStrictEqual(names(yield* records.getDescendants(orgId, a.id)), ["B", "C"]);
            const unknown = yield* records
              .moveTeam({ organizationId: orgId, id: "no-such", parentId: Option.none() })
              .pipe(Effect.flip);
            assert.strictEqual(unknown._tag, "TeamRecordNotFound");
          }),
        },
      ],
      race: [
        {
          name: "crossing moves never make a cycle, 8 rounds (plan 24 C1)",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            for (let round = 0; round < RecordsContract.CONCURRENCY; round++) {
              const a = yield* team(`a-${round}`);
              const b = yield* team(`b-${round}`);
              const outcomes = yield* Effect.all(
                [
                  Effect.map(
                    Effect.exit(
                      records.moveTeam({
                        organizationId: orgId,
                        id: a.id,
                        parentId: Option.some(b.id),
                      }),
                    ),
                    exitTag,
                  ),
                  Effect.map(
                    Effect.exit(
                      records.moveTeam({
                        organizationId: orgId,
                        id: b.id,
                        parentId: Option.some(a.id),
                      }),
                    ),
                    exitTag,
                  ),
                ],
                { concurrency: "unbounded" },
              );
              assert.deepStrictEqual(
                [...outcomes].sort(),
                ["TeamRecords/HierarchyCycle", "ok"],
                `round ${round}`,
              );
              const aboveA = (yield* records.getAncestors(orgId, a.id)).map((row) => row.id);
              const aboveB = (yield* records.getAncestors(orgId, b.id)).map((row) => row.id);
              assert.isFalse(
                aboveA.includes(b.id) && aboveB.includes(a.id),
                `round ${round}: a cycle`,
              );
            }
          }),
        },
      ],
    },
    getAncestors: {
      read: [
        {
          name: "nested creates expose parentId and single-lookup ancestor/descendant/subtree reads",
          run: Effect.gen(function* () {
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
          }),
        },
      ],
    },
    getDescendants: {
      read: [
        {
          name: "every team below, nearest first, excluding the team",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const a = yield* team("A");
            const b = yield* team("B", a.id);
            const c = yield* team("C", b.id);
            const below = (yield* records.getDescendants(orgId, a.id)).map((row) => row.id);
            assert.deepStrictEqual(below, [b.id, c.id]);
          }),
        },
      ],
    },
    getSubtree: {
      read: [
        {
          name: "the team followed by its descendants",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const a = yield* team("A");
            const b = yield* team("B", a.id);
            const subtree = (yield* records.getSubtree(orgId, a.id)).map((row) => row.id);
            assert.deepStrictEqual(subtree, [a.id, b.id]);
          }),
        },
      ],
    },
    removeTeam: {
      atomic: [
        {
          name: "removeTeam deletes the team and cascades its memberships",
          run: Effect.gen(function* () {
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
          }),
        },
        {
          name: "removeTeam refuses a team with children (TeamHasChildren); a leaf removes cleanly",
          run: Effect.gen(function* () {
            const { records, a, b, c } = yield* seedTree;
            const failure = yield* records.removeTeam(orgId, b.id).pipe(Effect.flip);
            assert.strictEqual(failure._tag, "TeamRecords/HasChildren");
            yield* records.removeTeam(orgId, c.id);
            assert.deepStrictEqual(names(yield* records.getDescendants(orgId, a.id)), ["B"]);
            yield* records.removeTeam(orgId, b.id);
            assert.deepStrictEqual(names(yield* records.getDescendants(orgId, a.id)), []);
          }),
        },
        {
          name: "keepOne refuses the organization's last team (TeamRecords/LastTeam)",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const a = yield* team("A");
            const b = yield* team("B");
            yield* records.removeTeam(orgId, a.id, { keepOne: true });
            const refused = yield* Effect.flip(records.removeTeam(orgId, b.id, { keepOne: true }));
            assert.strictEqual(refused._tag, "TeamRecords/LastTeam");
            // Without keepOne the last team goes.
            yield* records.removeTeam(orgId, b.id);
            assert.strictEqual(yield* records.countTeamsByOrganization(orgId), 0);
          }),
        },
      ],
      race: [
        {
          name: "8 teams removed concurrently with keepOne leave exactly one",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const teams = [];
            for (let n = 0; n < RecordsContract.CONCURRENCY; n++) teams.push(yield* team(`t${n}`));
            const outcomes = yield* Effect.all(
              teams.map((row) =>
                Effect.map(
                  Effect.exit(records.removeTeam(orgId, row.id, { keepOne: true })),
                  exitTag,
                ),
              ),
              { concurrency: "unbounded" },
            );
            assert.deepStrictEqual(
              outcomes.filter((tag) => tag !== "ok"),
              ["TeamRecords/LastTeam"],
            );
            assert.strictEqual(yield* records.countTeamsByOrganization(orgId), 1);
          }),
        },
      ],
    },
    removeAllTeamsForOrganization: {
      write: [
        {
          name: "removeAllTeamsForOrganization removes every team and membership for that org only",
          run: Effect.gen(function* () {
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
          }),
        },
      ],
    },
    addTeamMember: {
      atomic: [
        {
          name: "addTeamMember/removeTeamMember maintain memberCount and round-trip membership",
          run: Effect.gen(function* () {
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
          }),
        },
        // OHS-003: one membership per (teamId, userId); memberCount can never over-count.
        {
          name: "adding the same user to a team twice fails TeamMembershipRecordAlreadyExists and memberCount stays 1",
          run: Effect.gen(function* () {
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
          }),
        },
        {
          name: "within refuses at maximumMembersPerTeam (TeamRecords/MemberLimitReached) and stores nothing",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const t = yield* team("T");
            yield* records.addTeamMember(
              { teamId: t.id, userId: Users.UserId("u1") },
              { within: 1 },
            );
            const refused = yield* Effect.flip(
              records.addTeamMember({ teamId: t.id, userId: Users.UserId("u2") }, { within: 1 }),
            );
            assert.strictEqual(refused._tag, "TeamRecords/MemberLimitReached");
            assert.strictEqual((yield* records.listTeamMembers(t.id)).length, 1);
            assert.strictEqual(
              Option.getOrThrow(yield* records.findTeamById(orgId, t.id)).memberCount,
              1,
            );
          }),
        },
      ],
      race: [
        {
          name: "8 adds racing at within - 1 store exactly one",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const t = yield* team("T");
            yield* records.addTeamMember({ teamId: t.id, userId: Users.UserId("first") });
            const outcomes = yield* Effect.all(
              Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) =>
                Effect.map(
                  Effect.exit(
                    records.addTeamMember(
                      { teamId: t.id, userId: Users.UserId(`r${n}`) },
                      { within: 2 },
                    ),
                  ),
                  exitTag,
                ),
              ),
              { concurrency: "unbounded" },
            );
            assert.strictEqual(outcomes.filter((tag) => tag === "ok").length, 1);
            assert.strictEqual((yield* records.listTeamMembers(t.id)).length, 2);
            assert.strictEqual(
              Option.getOrThrow(yield* records.findTeamById(orgId, t.id)).memberCount,
              2,
            );
          }),
        },
      ],
    },
    updateTeamMemberRole: {
      write: [
        // OHS-004: a team membership carries role names, "member" by default.
        {
          name: "team memberships default to the member role and updateTeamMemberRole replaces it",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const team = yield* records.createTeam({ organizationId: orgId, name: "Eng" });
            const plain = yield* records.addTeamMember({
              teamId: team.id,
              userId: Users.UserId("u-1"),
            });
            assert.deepStrictEqual(plain.role, ["member"]);
            const lead = yield* records.addTeamMember({
              teamId: team.id,
              userId: Users.UserId("u-2"),
              role: ["lead", "auditor"],
            });
            assert.deepStrictEqual(lead.role, ["lead", "auditor"]);

            const updated = yield* records.updateTeamMemberRole(team.id, Users.UserId("u-1"), [
              "lead",
            ]);
            assert.deepStrictEqual(updated.role, ["lead"]);
            const found = yield* records.findTeamMembership(team.id, Users.UserId("u-1"));
            assert.deepStrictEqual(
              Option.map(found, (m) => m.role),
              Option.some(["lead"]),
            );
            const failure = yield* records
              .updateTeamMemberRole(team.id, Users.UserId("nobody"), ["lead"])
              .pipe(Effect.flip);
            assert.strictEqual(failure._tag, "TeamMembershipRecordNotFound");
          }),
        },
      ],
    },
    removeTeamMember: {
      atomic: [
        {
          name: "decrements memberCount; a missing membership is TeamMembershipRecordNotFound",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const t = yield* team("T");
            yield* records.addTeamMember({ teamId: t.id, userId: Users.UserId("u1") });
            yield* records.removeTeamMember(t.id, Users.UserId("u1"));
            assert.strictEqual(
              Option.getOrThrow(yield* records.findTeamById(orgId, t.id)).memberCount,
              0,
            );
            const missing = yield* Effect.flip(records.removeTeamMember(t.id, Users.UserId("u1")));
            assert.strictEqual(missing._tag, "TeamMembershipRecordNotFound");
          }),
        },
      ],
      race: [
        {
          name: "a member removed 8 times concurrently is decremented once (plan 24 C3)",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const t = yield* team("T");
            yield* records.addTeamMember({ teamId: t.id, userId: Users.UserId("u1") });
            yield* records.addTeamMember({ teamId: t.id, userId: Users.UserId("u2") });
            const outcomes = yield* RecordsContract.race(
              Effect.map(Effect.exit(records.removeTeamMember(t.id, Users.UserId("u1"))), exitTag),
            );
            assert.strictEqual(outcomes.filter((tag) => tag === "ok").length, 1);
            assert.strictEqual(
              Option.getOrThrow(yield* records.findTeamById(orgId, t.id)).memberCount,
              1,
            );
          }),
        },
      ],
    },
    removeUserFromOrganizationTeams: {
      atomic: [
        {
          name: "removes the user from that organization's teams only, answering the teams it was on",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const a = yield* team("A");
            const b = yield* team("B");
            const other = yield* records.createTeam({ organizationId: "org-other", name: "O" });
            for (const t of [a, other])
              yield* records.addTeamMember({ teamId: t.id, userId: Users.UserId("u1") });
            const removed = yield* records.removeUserFromOrganizationTeams(
              orgId,
              Users.UserId("u1"),
            );
            assert.deepStrictEqual(removed, [a.id]);
            assert.isTrue(
              Option.isNone(yield* records.findTeamMembership(b.id, Users.UserId("u1"))),
            );
            assert.isTrue(
              Option.isSome(yield* records.findTeamMembership(other.id, Users.UserId("u1"))),
            );
            assert.strictEqual(
              Option.getOrThrow(yield* records.findTeamById(orgId, a.id)).memberCount,
              0,
            );
          }),
        },
      ],
      race: [
        {
          name: "racing removeTeamMember, the count is decremented once and never negative (plan 24 C3)",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const t = yield* team("T");
            yield* records.addTeamMember({ teamId: t.id, userId: Users.UserId("u1") });
            yield* Effect.all(
              [
                ...Array.from({ length: RecordsContract.CONCURRENCY / 2 }, () =>
                  Effect.exit(records.removeUserFromOrganizationTeams(orgId, Users.UserId("u1"))),
                ),
                ...Array.from({ length: RecordsContract.CONCURRENCY / 2 }, () =>
                  Effect.exit(records.removeTeamMember(t.id, Users.UserId("u1"))),
                ),
              ],
              { concurrency: "unbounded" },
            );
            assert.strictEqual(
              Option.getOrThrow(yield* records.findTeamById(orgId, t.id)).memberCount,
              0,
            );
          }),
        },
      ],
    },
    removeUserFromAllTeams: {
      write: [
        {
          name: "removes the user from every team, across organizations",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const a = yield* team("A");
            const other = yield* records.createTeam({ organizationId: "org-other", name: "O" });
            for (const t of [a, other])
              yield* records.addTeamMember({ teamId: t.id, userId: Users.UserId("u1") });
            yield* records.removeUserFromAllTeams(grant, Users.UserId("u1"));
            assert.isTrue(
              Option.isNone(yield* records.findTeamMembership(a.id, Users.UserId("u1"))),
            );
            assert.isTrue(
              Option.isNone(yield* records.findTeamMembership(other.id, Users.UserId("u1"))),
            );
            assert.strictEqual(
              Option.getOrThrow(yield* records.findTeamById("org-other", other.id)).memberCount,
              0,
            );
          }),
        },
      ],
    },
    findTeamMembership: {
      read: [
        {
          name: "finds one user's membership of one team",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const t = yield* team("T");
            yield* records.addTeamMember({ teamId: t.id, userId: Users.UserId("u1") });
            assert.isTrue(
              Option.isSome(yield* records.findTeamMembership(t.id, Users.UserId("u1"))),
            );
            assert.isTrue(
              Option.isNone(yield* records.findTeamMembership(t.id, Users.UserId("u2"))),
            );
          }),
        },
      ],
    },
    listTeamMembers: {
      read: [
        {
          name: "lists the team's members",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const t = yield* team("T");
            for (const id of ["u1", "u2"])
              yield* records.addTeamMember({ teamId: t.id, userId: Users.UserId(id) });
            const members = (yield* records.listTeamMembers(t.id)).map((row) => row.userId);
            assert.deepStrictEqual([...members].sort(), ["u1", "u2"]);
          }),
        },
      ],
    },
    listTeamsByUser: {
      read: [
        {
          name: "listTeamsByUser returns only teams, within one org, the user belongs to",
          run: Effect.gen(function* () {
            const records = yield* TeamRecords.TeamRecords;
            const teamA = yield* records.createTeam({ organizationId: orgId, name: "A" });
            yield* records.createTeam({ organizationId: orgId, name: "B" });
            const teamC = yield* records.createTeam({ organizationId: "other-org", name: "C" });
            yield* records.addTeamMember({ teamId: teamA.id, userId: Users.UserId("user-1") });
            yield* records.addTeamMember({ teamId: teamC.id, userId: Users.UserId("user-1") });

            const teams = yield* records.listTeamsByUser(orgId, Users.UserId("user-1"));
            assert.strictEqual(teams.length, 1);
            assert.strictEqual(teams[0]?.id, teamA.id);
          }),
        },
      ],
    },
  },
  // OHS-002 and OHS-001: what the database holds after a mid-operation failure, and the closure table itself.
  sql: [
    {
      name: "removeTeam deletes the team and its memberships atomically",
      run: Effect.gen(function* () {
        const records = yield* TeamRecords.TeamRecords;
        const sql = yield* SqlClient.SqlClient;
        const team = yield* records.createTeam({ organizationId: orgId, name: "Engineering" });
        yield* records.addTeamMember({ teamId: team.id, userId: Users.UserId("user-1") });
        yield* TestSql.injectFailure({
          name: "fail_team_membership_delete",
          table: "organization_team_membership",
          event: "DELETE",
        });
        const exit = yield* Effect.exit(records.removeTeam(orgId, team.id));
        assert.isTrue(Exit.isFailure(exit));
        // The team row's own DELETE ran first; it must have been rolled back.
        const rows = yield* sql`SELECT id FROM organization_team WHERE id = ${team.id}`;
        assert.strictEqual(rows.length, 1);
      }),
    },
    {
      name: "addTeamMember inserts the row and bumps memberCount atomically",
      run: Effect.gen(function* () {
        const records = yield* TeamRecords.TeamRecords;
        const sql = yield* SqlClient.SqlClient;
        const team = yield* records.createTeam({ organizationId: orgId, name: "Engineering" });
        yield* TestSql.injectFailure({
          name: "fail_team_count",
          table: "organization_team",
          event: "UPDATE",
        });
        const exit = yield* Effect.exit(
          records.addTeamMember({ teamId: team.id, userId: Users.UserId("user-1") }),
        );
        assert.isTrue(Exit.isFailure(exit));
        const rows =
          yield* sql`SELECT id FROM organization_team_membership WHERE "teamId" = ${team.id}`;
        assert.strictEqual(rows.length, 0);
      }),
    },
    {
      name: "removeAllTeamsForOrganization deletes memberships and teams atomically",
      run: Effect.gen(function* () {
        const records = yield* TeamRecords.TeamRecords;
        const sql = yield* SqlClient.SqlClient;
        const team = yield* records.createTeam({ organizationId: "org-x", name: "X" });
        yield* records.addTeamMember({ teamId: team.id, userId: Users.UserId("user-1") });
        yield* TestSql.injectFailure({
          name: "fail_team_delete",
          table: "organization_team",
          event: "DELETE",
        });
        const exit = yield* Effect.exit(records.removeAllTeamsForOrganization("org-x"));
        assert.isTrue(Exit.isFailure(exit));
        const rows =
          yield* sql`SELECT id FROM organization_team_membership WHERE "teamId" = ${team.id}`;
        assert.strictEqual(rows.length, 1);
      }),
    },
    {
      name: "closure rows track nested creates, moves, removals and organization cascades",
      run: Effect.gen(function* () {
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
      }),
    },
  ],
  tenancy: {
    covers: ["organization_team", "organization_team_membership", "organization_team_closure"],
    cases: [
      { table: "organization_team", insert: insertRow, methods: teamMethods },
      { table: "organization_team_membership", insert: insertRow, methods: membershipMethods },
      { table: "organization_team_closure", insert: insertRow, methods: closureMethods },
    ],
  },
});
