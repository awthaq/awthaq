// Plan 04 (ADR-EA-040): `OrganizationTeams`, tested at its own interface. No `Api.UserPrincipal`
// appears here: the system interface takes an `Actor`, and every policy a team operation has
// (`teams.enabled`, the quotas, the last-team rule, vetoes, the transaction, `Bound`) is proved
// without the authorized layer. `Organization.test.ts` keeps only the authorization half.
import { HookPoint, Migrations, Persistence, Users } from "@awthaq/core";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import { TestAuth } from "@awthaq/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";
import * as InvitationRecords from "../src/InvitationRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationActor from "../src/OrganizationActor.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";
import * as OrganizationMemory from "../src/OrganizationMemory.ts";
import * as OrganizationRecords from "../src/OrganizationRecords.ts";
import * as OrganizationSystem from "../src/OrganizationSystem.ts";
import * as OrganizationTeams from "../src/OrganizationTeams.ts";
import * as OrgRoleRecords from "../src/OrgRoleRecords.ts";
import * as TeamRecords from "../src/TeamRecords.ts";
import { TestSql } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { grant } from "./support.ts";

const teamsOn = (overrides: Partial<Organization.OrganizationConfigShape["teams"]> = {}) => ({
  enabled: true,
  maximumTeams: Number.POSITIVE_INFINITY,
  maximumMembersPerTeam: Number.POSITIVE_INFINITY,
  allowRemovingAllTeams: false,
  ...overrides,
});

const NoTaps = Layer.empty;

/** The system layer over memory records. `taps` are hook layers installed on the shared points. */
const buildLayer = (
  config: Partial<Organization.OrganizationConfigShape> = { teams: teamsOn() },
  taps: Layer.Layer<
    never,
    never,
    Layer.Success<typeof OrganizationHooks.OrganizationHooksLive>
  > = NoTaps,
) =>
  OrganizationSystem.layer.pipe(
    Layer.provide(Organization.config(config)),
    Layer.provideMerge(OrganizationMemory.layer),
    Layer.provideMerge(
      Layer.mergeAll(Users.layer.pipe(Layer.provide(Persistence.memory)), Mailer.layerMemory),
    ),
    Layer.provideMerge(TestAuth.memoryFoundation),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(taps),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  );

const application = OrganizationActor.application("OrganizationTeams.test");
const unbounded = OrganizationActor.Bound.Unbounded();
const userId = Users.UserId;

/** An organization, with these users as plain `member`s (arranged through the records, not the authorized layer). */
const arrange = (memberIds: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const orgs = yield* OrganizationRecords.OrganizationRecords;
    const members = yield* MembershipRecords.MembershipRecords;
    const teams = yield* OrganizationTeams.OrganizationTeams;
    const org = yield* orgs.create({ name: "Acme", slug: "acme" });
    for (const id of memberIds) {
      yield* members.create({ userId: userId(id), organizationId: org.id, role: ["member"] });
    }
    return { org, teams, orgs, members };
  });

const flipTag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error._tag),
  );

describe("OrganizationTeams: the gate (SUSP, teams.enabled)", () => {
  it.effect("every mutator answers TeamsDisabled while teams are off", () =>
    Effect.gen(function* () {
      const { org, teams } = yield* arrange(["u1"]);
      const input = { organizationId: org.id, teamId: "t" };
      assert.strictEqual(
        yield* flipTag(teams.create(application, { organizationId: org.id, name: "Eng" })),
        "TeamsDisabled",
      );
      assert.strictEqual(
        yield* flipTag(teams.rename(application, { ...input, name: "x" })),
        "TeamsDisabled",
      );
      assert.strictEqual(
        yield* flipTag(teams.move(application, { ...input, parentId: Option.none() })),
        "TeamsDisabled",
      );
      assert.strictEqual(yield* flipTag(teams.remove(application, input)), "TeamsDisabled");
      assert.strictEqual(
        yield* flipTag(
          teams.addMember(application, { ...input, userId: userId("u1"), bound: unbounded }),
        ),
        "TeamsDisabled",
      );
      assert.strictEqual(
        yield* flipTag(
          teams.setMemberRole(application, {
            ...input,
            userId: userId("u1"),
            role: ["lead"],
            bound: unbounded,
          }),
        ),
        "TeamsDisabled",
      );
      assert.strictEqual(
        yield* flipTag(teams.removeMember(application, { ...input, userId: userId("u1") })),
        "TeamsDisabled",
      );
      assert.strictEqual(
        yield* flipTag(
          teams.applyRoster(application, { ...input, add: [], remove: [], bound: unbounded }),
        ),
        "TeamsDisabled",
      );
    }).pipe(Effect.provide(buildLayer({}))),
  );

  it.effect("a suspended organization answers OrganizationNotFound", () =>
    Effect.gen(function* () {
      const { org, teams, orgs } = yield* arrange();
      const created = yield* teams.create(application, { organizationId: org.id, name: "Eng" });
      yield* orgs.setSuspended(grant, org.id, Option.some(yield* nowUtc));
      assert.strictEqual(
        yield* flipTag(teams.create(application, { organizationId: org.id, name: "Sales" })),
        "OrganizationNotFound",
      );
      assert.strictEqual(
        yield* flipTag(
          teams.rename(application, {
            organizationId: org.id,
            teamId: created.team.id,
            name: "x",
          }),
        ),
        "OrganizationNotFound",
      );
      yield* orgs.setSuspended(grant, org.id, Option.none());
      yield* teams.create(application, { organizationId: org.id, name: "Sales" });
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("the configuration in force for the calling fiber applies per call (EP-007)", () =>
    Effect.gen(function* () {
      const { org, teams } = yield* arrange();
      // Build-time config says teams are on; this fiber's tenant says off.
      const off = yield* flipTag(
        teams.create(application, { organizationId: org.id, name: "Eng" }).pipe(
          Effect.provideService(Organization.OrganizationConfig, {
            ...(yield* Organization.OrganizationConfig),
            teams: teamsOn({ enabled: false }),
          }),
        ),
      );
      assert.strictEqual(off, "TeamsDisabled");
      yield* teams.create(application, { organizationId: org.id, name: "Eng" });
    }).pipe(Effect.provide(buildLayer())),
  );
});

const nowUtc = DateTime.now;

describe("OrganizationTeams: create and the quotas", () => {
  it.effect("maximumTeams (static) and a limitsFor override (EP-006)", () =>
    Effect.gen(function* () {
      const { org, teams } = yield* arrange();
      yield* teams.create(application, { organizationId: org.id, name: "One" });
      assert.strictEqual(
        yield* flipTag(teams.create(application, { organizationId: org.id, name: "Two" })),
        "TeamLimitReached",
      );
    }).pipe(Effect.provide(buildLayer({ teams: teamsOn({ maximumTeams: 1 }) }))),
  );

  it.effect("limitsFor raises the quota for one organization only", () =>
    Effect.gen(function* () {
      const { org, teams } = yield* arrange();
      yield* teams.create(application, { organizationId: org.id, name: "One" });
      yield* teams.create(application, { organizationId: org.id, name: "Two" });
      assert.strictEqual(
        yield* flipTag(teams.create(application, { organizationId: org.id, name: "Three" })),
        "TeamLimitReached",
      );
    }).pipe(
      Effect.provide(
        buildLayer({
          teams: teamsOn({ maximumTeams: 1 }),
          limitsFor: () => Effect.succeed({ maximumTeams: 2 }),
        }),
      ),
    ),
  );

  it.effect("a parent in another organization is TeamNotFound", () =>
    Effect.gen(function* () {
      const { org, teams, orgs } = yield* arrange();
      const other = yield* orgs.create({ name: "Other", slug: "other" });
      const foreign = yield* teams.create(application, { organizationId: other.id, name: "F" });
      assert.strictEqual(
        yield* flipTag(
          teams.create(application, {
            organizationId: org.id,
            name: "Nested",
            parentId: foreign.team.id,
          }),
        ),
        "TeamNotFound",
      );
      const own = yield* teams.create(application, { organizationId: org.id, name: "Own" });
      assert.strictEqual(
        yield* flipTag(
          teams.move(application, {
            organizationId: org.id,
            teamId: own.team.id,
            parentId: Option.some(foreign.team.id),
          }),
        ),
        "TeamNotFound",
      );
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("initialMembers join the new team with the member role, in the same unit", () =>
    Effect.gen(function* () {
      const { org, teams } = yield* arrange(["u1", "u2"]);
      const { team } = yield* teams.create(application, {
        organizationId: org.id,
        name: "Eng",
        initialMembers: [userId("u1"), userId("u2"), userId("u1")],
      });
      assert.strictEqual(team.memberCount, 2);
      const roster = yield* teams.members(org.id, team.id);
      assert.deepStrictEqual(
        roster.map((row) => row.role),
        [["member"], ["member"]],
      );
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("an initial member who is not in the organization writes nothing", () =>
    Effect.gen(function* () {
      const { org, teams } = yield* arrange(["u1"]);
      assert.strictEqual(
        yield* flipTag(
          teams.create(application, {
            organizationId: org.id,
            name: "Eng",
            initialMembers: [userId("u1"), userId("stranger")],
          }),
        ),
        "MembershipNotFound",
      );
      assert.deepStrictEqual(yield* teams.list(org.id), []);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a roster over maximumMembersPerTeam writes nothing", () =>
    Effect.gen(function* () {
      const { org, teams } = yield* arrange(["u1", "u2"]);
      assert.strictEqual(
        yield* flipTag(
          teams.create(application, {
            organizationId: org.id,
            name: "Eng",
            initialMembers: [userId("u1"), userId("u2")],
          }),
        ),
        "TeamMemberLimitReached",
      );
      assert.deepStrictEqual(yield* teams.list(org.id), []);
    }).pipe(Effect.provide(buildLayer({ teams: teamsOn({ maximumMembersPerTeam: 1 }) }))),
  );
});

describe("OrganizationTeams: hooks", () => {
  it.effect("a veto on create aborts with the point's id and writes nothing", () =>
    Effect.gen(function* () {
      const { org, teams } = yield* arrange();
      const aborted = yield* teams
        .create(application, { organizationId: org.id, name: "forbidden" })
        .pipe(Effect.flip);
      assert.strictEqual(aborted._tag, "HookAborted");
      if (aborted._tag === "HookAborted") {
        assert.strictEqual(aborted.point, OrganizationHooks.BeforeCreateTeam.id);
        assert.strictEqual(aborted.code, "NAME_FORBIDDEN");
      }
      assert.deepStrictEqual(yield* teams.list(org.id), []);
    }).pipe(
      Effect.provide(
        buildLayer(
          { teams: teamsOn() },
          OrganizationHooks.BeforeCreateTeam.tap((input) =>
            input.name === "forbidden"
              ? Effect.fail(new HookPoint.HookAbort({ code: "NAME_FORBIDDEN" }))
              : Effect.succeed(input),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "the veto and the observe point carry the actor, and an observe failure never surfaces",
    () => {
      const seen: Array<string> = [];
      return Effect.gen(function* () {
        const { org, teams } = yield* arrange();
        const actor = OrganizationActor.directory("conn-1");
        const { team } = yield* teams.create(actor, { organizationId: org.id, name: "Eng" });
        assert.strictEqual(team.name, "Eng");
        assert.deepStrictEqual(seen, ["before:Directory:conn-1", "after:Directory:conn-1"]);
      }).pipe(
        Effect.provide(
          buildLayer(
            { teams: teamsOn() },
            Layer.mergeAll(
              OrganizationHooks.BeforeCreateTeam.tap((input) => {
                seen.push(
                  `before:${input.actor._tag}:${"connectionId" in input.actor ? input.actor.connectionId : ""}`,
                );
                return Effect.succeed(input);
              }),
              OrganizationHooks.AfterCreateTeam.tap((input) => {
                seen.push(
                  `after:${input.actor._tag}:${"connectionId" in input.actor ? input.actor.connectionId : ""}`,
                );
                return Effect.fail("observer exploded, this must never surface");
              }),
            ),
          ),
        ),
      );
    },
  );

  it.effect("a module ignores an actor a veto tap amended", () => {
    const seen: Array<string> = [];
    return Effect.gen(function* () {
      const { org, teams } = yield* arrange();
      yield* teams.create(OrganizationActor.directory("real"), {
        organizationId: org.id,
        name: "Eng",
      });
      assert.deepStrictEqual(seen, ["Directory"]);
    }).pipe(
      Effect.provide(
        buildLayer(
          { teams: teamsOn() },
          Layer.mergeAll(
            OrganizationHooks.BeforeCreateTeam.tap((input) =>
              Effect.succeed({ ...input, actor: OrganizationActor.application("forged") }),
            ),
            OrganizationHooks.AfterCreateTeam.tap((input) => {
              seen.push(input.actor._tag);
              return Effect.void;
            }),
          ),
        ),
      ),
    );
  });
});

describe("OrganizationTeams: the hierarchy", () => {
  it.effect("nested create, ancestors, descendants and move re-parent a subtree", () =>
    Effect.gen(function* () {
      const { org, teams } = yield* arrange();
      const make = (name: string, parentId?: string) =>
        teams
          .create(application, { organizationId: org.id, name, parentId })
          .pipe(Effect.map((created) => created.team));
      const eng = yield* make("Engineering");
      const platform = yield* make("Platform", eng.id);
      const infra = yield* make("Infra", platform.id);
      const sales = yield* make("Sales");
      const names = (rows: ReadonlyArray<{ readonly name: string }>) => rows.map((row) => row.name);
      assert.deepStrictEqual(platform.parentId, Option.some(eng.id));
      assert.deepStrictEqual(names(yield* teams.ancestors(org.id, infra.id)), [
        "Platform",
        "Engineering",
      ]);
      assert.deepStrictEqual(names(yield* teams.descendants(org.id, eng.id)), [
        "Platform",
        "Infra",
      ]);
      yield* teams.move(application, {
        organizationId: org.id,
        teamId: platform.id,
        parentId: Option.some(sales.id),
      });
      assert.deepStrictEqual(names(yield* teams.ancestors(org.id, infra.id)), [
        "Platform",
        "Sales",
      ]);
      yield* teams.move(application, {
        organizationId: org.id,
        teamId: platform.id,
        parentId: Option.none(),
      });
      assert.deepStrictEqual(names(yield* teams.descendants(org.id, eng.id)), []);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a cycle is TeamHierarchyCycle", () =>
    Effect.gen(function* () {
      const { org, teams } = yield* arrange();
      const parent = (yield* teams.create(application, { organizationId: org.id, name: "P" })).team;
      const child = (yield* teams.create(application, {
        organizationId: org.id,
        name: "C",
        parentId: parent.id,
      })).team;
      assert.strictEqual(
        yield* flipTag(
          teams.move(application, {
            organizationId: org.id,
            teamId: parent.id,
            parentId: Option.some(child.id),
          }),
        ),
        "TeamHierarchyCycle",
      );
    }).pipe(Effect.provide(buildLayer())),
  );
});

describe("OrganizationTeams: remove", () => {
  it.effect("the last team is LastTeamCannotBeRemoved unless allowRemovingAllTeams", () =>
    Effect.gen(function* () {
      const { org, teams } = yield* arrange();
      const only = (yield* teams.create(application, { organizationId: org.id, name: "Only" }))
        .team;
      assert.strictEqual(
        yield* flipTag(teams.remove(application, { organizationId: org.id, teamId: only.id })),
        "LastTeamCannotBeRemoved",
      );
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("allowRemovingAllTeams lets a directory delete every team", () =>
    Effect.gen(function* () {
      const { org, teams } = yield* arrange();
      const only = (yield* teams.create(application, { organizationId: org.id, name: "Only" }))
        .team;
      yield* teams.remove(application, { organizationId: org.id, teamId: only.id });
      assert.deepStrictEqual(yield* teams.list(org.id), []);
    }).pipe(Effect.provide(buildLayer({ teams: teamsOn({ allowRemovingAllTeams: true }) }))),
  );

  it.effect("a team with children is TeamHasChildren before the veto runs", () => {
    let vetoes = 0;
    return Effect.gen(function* () {
      const { org, teams } = yield* arrange();
      const parent = (yield* teams.create(application, { organizationId: org.id, name: "P" })).team;
      yield* teams.create(application, { organizationId: org.id, name: "C", parentId: parent.id });
      assert.strictEqual(
        yield* flipTag(teams.remove(application, { organizationId: org.id, teamId: parent.id })),
        "TeamHasChildren",
      );
      assert.strictEqual(vetoes, 0);
    }).pipe(
      Effect.provide(
        buildLayer(
          { teams: teamsOn() },
          OrganizationHooks.BeforeDeleteTeam.tap((input) => {
            vetoes += 1;
            return Effect.succeed(input);
          }),
        ),
      ),
    );
  });

  it.effect("removing a team clears every session's active team in the same unit (CWM-003)", () =>
    Effect.gen(function* () {
      const { org, teams } = yield* arrange(["u1"]);
      const activeContext = yield* ActiveContextRecords.ActiveContextRecords;
      const records = yield* TeamRecords.TeamRecords;
      const keep = (yield* teams.create(application, { organizationId: org.id, name: "Keep" }))
        .team;
      const doomed = (yield* teams.create(application, { organizationId: org.id, name: "Doomed" }))
        .team;
      yield* teams.addMember(application, {
        organizationId: org.id,
        teamId: doomed.id,
        userId: userId("u1"),
        bound: unbounded,
      });
      const membership = yield* records.findTeamMembership(doomed.id, userId("u1"));
      yield* activeContext.setTeam("s1", Option.getOrThrow(membership));
      yield* teams.remove(application, { organizationId: org.id, teamId: doomed.id });
      const after = yield* activeContext.findBySessionId("s1");
      assert.isTrue(Option.isNone(Option.getOrThrow(after).activeTeamId));
      assert.deepStrictEqual(
        (yield* teams.list(org.id)).map((team) => team.id),
        [keep.id],
      );
    }).pipe(Effect.provide(buildLayer())),
  );
});

describe("OrganizationTeams: rosters", () => {
  it.effect("addMember needs an organization member, a known role, and refuses a duplicate", () =>
    Effect.gen(function* () {
      const { org, teams } = yield* arrange(["u1"]);
      const team = (yield* teams.create(application, { organizationId: org.id, name: "Eng" })).team;
      const base = { organizationId: org.id, teamId: team.id, bound: unbounded };
      assert.strictEqual(
        yield* flipTag(teams.addMember(application, { ...base, userId: userId("stranger") })),
        "MembershipNotFound",
      );
      assert.strictEqual(
        yield* flipTag(
          teams.addMember(application, { ...base, userId: userId("u1"), role: ["no-such-role"] }),
        ),
        "UnknownTeamRole",
      );
      const added = yield* teams.addMember(application, { ...base, userId: userId("u1") });
      assert.deepStrictEqual(added.role, ["member"]);
      assert.strictEqual(
        yield* flipTag(teams.addMember(application, { ...base, userId: userId("u1") })),
        "AlreadyTeamMember",
      );
      assert.strictEqual((yield* teams.members(org.id, team.id)).length, 1);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("maximumMembersPerTeam refuses the add that would exceed it", () =>
    Effect.gen(function* () {
      const { org, teams } = yield* arrange(["u1", "u2"]);
      const team = (yield* teams.create(application, { organizationId: org.id, name: "Eng" })).team;
      const base = { organizationId: org.id, teamId: team.id, bound: unbounded };
      yield* teams.addMember(application, { ...base, userId: userId("u1") });
      assert.strictEqual(
        yield* flipTag(teams.addMember(application, { ...base, userId: userId("u2") })),
        "TeamMemberLimitReached",
      );
    }).pipe(Effect.provide(buildLayer({ teams: teamsOn({ maximumMembersPerTeam: 1 }) }))),
  );

  describe("the Bound on a conferred team role (RRM-001, OHS-004)", () => {
    const config = {
      teams: teamsOn(),
      teamStatements: { lead: { team: ["update"] }, chief: { team: ["update", "delete"] } },
    } satisfies Partial<Organization.OrganizationConfigShape>;
    const ceiling = OrganizationActor.Bound.Ceiling({ statements: { team: ["update"] } });

    it.effect("a Ceiling refuses a role that confers more; Unbounded admits it", () =>
      Effect.gen(function* () {
        const { org, teams } = yield* arrange(["u1", "u2"]);
        const team = (yield* teams.create(application, { organizationId: org.id, name: "Eng" }))
          .team;
        const base = { organizationId: org.id, teamId: team.id };
        const peer = yield* teams.addMember(application, {
          ...base,
          userId: userId("u1"),
          role: ["lead"],
          bound: ceiling,
        });
        assert.deepStrictEqual(peer.role, ["lead"]);
        assert.strictEqual(
          yield* flipTag(
            teams.addMember(application, {
              ...base,
              userId: userId("u2"),
              role: ["chief"],
              bound: ceiling,
            }),
          ),
          "RolePermissionEscalation",
        );
        const chief = yield* teams.addMember(application, {
          ...base,
          userId: userId("u2"),
          role: ["chief"],
          bound: unbounded,
        });
        assert.deepStrictEqual(chief.role, ["chief"]);
      }).pipe(Effect.provide(buildLayer(config))),
    );

    it.effect("setMemberRole bounds the requested role and the role the member holds now", () =>
      Effect.gen(function* () {
        const { org, teams } = yield* arrange(["u1"]);
        const team = (yield* teams.create(application, { organizationId: org.id, name: "Eng" }))
          .team;
        const base = { organizationId: org.id, teamId: team.id, userId: userId("u1") };
        yield* teams.addMember(application, { ...base, role: ["chief"], bound: unbounded });
        // The ceiling cannot demote a member who out-privileges it.
        assert.strictEqual(
          yield* flipTag(
            teams.setMemberRole(application, { ...base, role: ["member"], bound: ceiling }),
          ),
          "RolePermissionEscalation",
        );
        const demoted = yield* teams.setMemberRole(application, {
          ...base,
          role: ["lead"],
          bound: unbounded,
        });
        assert.deepStrictEqual(demoted.role, ["lead"]);
        assert.strictEqual(
          yield* flipTag(
            teams.setMemberRole(application, {
              ...base,
              userId: userId("nobody"),
              role: ["lead"],
              bound: unbounded,
            }),
          ),
          "TeamMembershipNotFound",
        );
      }).pipe(Effect.provide(buildLayer(config))),
    );
  });

  describe("applyRoster", () => {
    it.effect("is idempotent per user and reports only what changed", () =>
      Effect.gen(function* () {
        const { org, teams } = yield* arrange(["u1", "u2", "u3"]);
        const team = (yield* teams.create(application, { organizationId: org.id, name: "Eng" }))
          .team;
        const base = { organizationId: org.id, teamId: team.id, bound: unbounded };
        yield* teams.addMember(application, { ...base, userId: userId("u1") });
        const first = yield* teams.applyRoster(application, {
          ...base,
          add: [userId("u1"), userId("u2")],
          remove: [userId("u3")],
        });
        assert.deepStrictEqual(first, { added: [userId("u2")], removed: [] });
        const second = yield* teams.applyRoster(application, {
          ...base,
          add: [userId("u2")],
          remove: [userId("u1")],
        });
        assert.deepStrictEqual(second, { added: [], removed: [userId("u1")] });
        assert.deepStrictEqual(
          (yield* teams.members(org.id, team.id)).map((row) => row.userId),
          [userId("u2")],
        );
      }).pipe(Effect.provide(buildLayer())),
    );

    it.effect("runs every veto before any write", () => {
      const vetoed: Array<string> = [];
      return Effect.gen(function* () {
        const { org, teams } = yield* arrange(["u1", "u2"]);
        const team = (yield* teams.create(application, { organizationId: org.id, name: "Eng" }))
          .team;
        const base = { organizationId: org.id, teamId: team.id, bound: unbounded };
        yield* teams.addMember(application, { ...base, userId: userId("u2") });
        const refused = yield* flipTag(
          teams.applyRoster(application, {
            ...base,
            add: [userId("u1")],
            remove: [userId("u2")],
          }),
        );
        assert.strictEqual(refused, "HookAborted");
        // The add veto passed and the remove veto aborted: neither change was written.
        assert.deepStrictEqual(
          (yield* teams.members(org.id, team.id)).map((row) => row.userId),
          [userId("u2")],
        );
        assert.deepStrictEqual(vetoed, ["add:u2", "add:u1"]);
      }).pipe(
        Effect.provide(
          buildLayer(
            { teams: teamsOn() },
            Layer.mergeAll(
              OrganizationHooks.BeforeAddTeamMember.tap((input) => {
                vetoed.push(`add:${input.userId}`);
                return Effect.succeed(input);
              }),
              OrganizationHooks.BeforeRemoveTeamMember.tap(() =>
                Effect.fail(new HookPoint.HookAbort({ code: "KEEP" })),
              ),
            ),
          ),
        ),
      );
    });

    it.effect("checks maximumMembersPerTeam against the final count", () =>
      Effect.gen(function* () {
        const { org, teams } = yield* arrange(["u1", "u2", "u3"]);
        const team = (yield* teams.create(application, { organizationId: org.id, name: "Eng" }))
          .team;
        const base = { organizationId: org.id, teamId: team.id, bound: unbounded };
        yield* teams.addMember(application, { ...base, userId: userId("u1") });
        // At the limit, swapping one member for another is not an increase.
        const swapped = yield* teams.applyRoster(application, {
          ...base,
          add: [userId("u2")],
          remove: [userId("u1")],
        });
        assert.deepStrictEqual(swapped, { added: [userId("u2")], removed: [userId("u1")] });
        assert.strictEqual(
          yield* flipTag(
            teams.applyRoster(application, { ...base, add: [userId("u3")], remove: [] }),
          ),
          "TeamMemberLimitReached",
        );
      }).pipe(Effect.provide(buildLayer({ teams: teamsOn({ maximumMembersPerTeam: 1 }) }))),
    );

    it.effect("fires one observe point per user actually changed, naming the actor", () => {
      const seen: Array<string> = [];
      return Effect.gen(function* () {
        const { org, teams } = yield* arrange(["u1", "u2"]);
        const team = (yield* teams.create(application, { organizationId: org.id, name: "Eng" }))
          .team;
        const base = { organizationId: org.id, teamId: team.id, bound: unbounded };
        yield* teams.addMember(application, { ...base, userId: userId("u2") });
        seen.length = 0;
        yield* teams.applyRoster(OrganizationActor.directory("c1"), {
          ...base,
          add: [userId("u1"), userId("u2")],
          remove: [userId("u2")],
        });
        assert.deepStrictEqual(seen, ["added:u1:Directory"]);
      }).pipe(
        Effect.provide(
          buildLayer(
            { teams: teamsOn() },
            OrganizationHooks.AfterAddTeamMember.tap((input) => {
              seen.push(`added:${input.userId}:${input.actor._tag}`);
              return Effect.void;
            }),
          ),
        ),
      );
    });
  });
});

describe("OrganizationTeams: attach", () => {
  it.effect("a failing attach leaves no team behind and publishes nothing (memory)", () => {
    const observed: Array<string> = [];
    return Effect.gen(function* () {
      const { org, teams } = yield* arrange(["u1"]);
      const failure = yield* teams
        .create(
          application,
          { organizationId: org.id, name: "Eng", initialMembers: [userId("u1")] },
          { attach: () => Effect.fail("link conflict" as const) },
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure, "link conflict");
      assert.deepStrictEqual(yield* teams.list(org.id), []);
      assert.deepStrictEqual(observed, []);
    }).pipe(
      Effect.provide(
        buildLayer(
          { teams: teamsOn() },
          OrganizationHooks.AfterCreateTeam.tap(() => {
            observed.push("after");
            return Effect.void;
          }),
        ),
      ),
    );
  });

  it.effect("attach sees the created team and its value comes back", () =>
    Effect.gen(function* () {
      const { org, teams } = yield* arrange();
      const { team, attached } = yield* teams.create(
        application,
        { organizationId: org.id, name: "Eng" },
        { attach: (created) => Effect.succeed(`linked:${created.id}`) },
      );
      assert.strictEqual(attached, `linked:${team.id}`);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("remove runs attach after the module's writes", () => {
    const order: Array<string> = [];
    return Effect.gen(function* () {
      const { org, teams } = yield* arrange();
      const team = (yield* teams.create(application, { organizationId: org.id, name: "Eng" })).team;
      yield* teams.remove(
        application,
        { organizationId: org.id, teamId: team.id },
        {
          attach: () =>
            Effect.gen(function* () {
              order.push(`attach:${(yield* teams.list(org.id)).length}`);
            }),
        },
      );
      assert.deepStrictEqual(order, ["attach:0"]);
    }).pipe(Effect.provide(buildLayer({ teams: teamsOn({ allowRemovingAllTeams: true }) })));
  });
});

// ---- over SQL: the unit really is one transaction -------------------------------------

const SqlLive = TestSql.layer("organization_OrganizationTeams");
const Migrated = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
  Layer.provide(SqlLive),
);
const sqlRecords = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(Layer.provide(NodeCrypto.layer));

const SqlSystemLive = OrganizationSystem.layer.pipe(
  Layer.provide(Organization.config({ teams: teamsOn({ allowRemovingAllTeams: true }) })),
  Layer.provideMerge(
    Layer.mergeAll(Users.layer.pipe(Layer.provide(Persistence.memory)), Mailer.layerMemory),
  ),
  Layer.provideMerge(TestAuth.memoryFoundation),
  Layer.provideMerge(sqlRecords(OrganizationRecords.layerSql)),
  Layer.provideMerge(sqlRecords(MembershipRecords.layerSql)),
  Layer.provideMerge(ActiveContextRecords.layerSql),
  Layer.provideMerge(sqlRecords(OrgRoleRecords.layerSql)),
  Layer.provideMerge(sqlRecords(InvitationRecords.layerSql)),
  Layer.provideMerge(sqlRecords(TeamRecords.layerSql)),
  Layer.provideMerge(SqlTransaction.layerSql),
  Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  Layer.provideMerge(Migrated),
  Layer.provideMerge(SqlLive),
);

const countRows = (sql: SqlClient.SqlClient, table: string) =>
  sql.unsafe(`SELECT COUNT(*) AS n FROM ${table}`).pipe(
    Effect.map((rows) => {
      const first = rows[0];
      return typeof first === "object" && first !== null && "n" in first ? Number(first.n) : -1;
    }),
  );

describe("OrganizationTeams over SQL", () => {
  it.effect("a failing attach rolls back the team and its roster", () =>
    Effect.gen(function* () {
      const orgs = yield* OrganizationRecords.OrganizationRecords;
      const members = yield* MembershipRecords.MembershipRecords;
      const teams = yield* OrganizationTeams.OrganizationTeams;
      const sql = yield* SqlClient.SqlClient;
      const org = yield* orgs.create({ name: "Acme", slug: "acme" });
      yield* members.create({ userId: userId("u1"), organizationId: org.id, role: ["member"] });
      const exit = yield* Effect.exit(
        teams.create(
          application,
          { organizationId: org.id, name: "Eng", initialMembers: [userId("u1")] },
          { attach: () => Effect.fail("link conflict" as const) },
        ),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(yield* countRows(sql, "organization_team"), 0);
      assert.strictEqual(yield* countRows(sql, "organization_team_membership"), 0);
    }).pipe(Effect.provide(SqlSystemLive)),
  );

  it.effect("remove rolls back when attach fails: the team and its memberships stay", () =>
    Effect.gen(function* () {
      const orgs = yield* OrganizationRecords.OrganizationRecords;
      const members = yield* MembershipRecords.MembershipRecords;
      const teams = yield* OrganizationTeams.OrganizationTeams;
      const sql = yield* SqlClient.SqlClient;
      const org = yield* orgs.create({ name: "Acme", slug: "acme" });
      yield* members.create({ userId: userId("u1"), organizationId: org.id, role: ["member"] });
      const { team } = yield* teams.create(application, {
        organizationId: org.id,
        name: "Eng",
        initialMembers: [userId("u1")],
      });
      const exit = yield* Effect.exit(
        teams.remove(
          application,
          { organizationId: org.id, teamId: team.id },
          { attach: () => Effect.fail("unlink failed" as const) },
        ),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(yield* countRows(sql, "organization_team"), 1);
      assert.strictEqual(yield* countRows(sql, "organization_team_membership"), 1);
    }).pipe(Effect.provide(SqlSystemLive)),
  );

  it.effect("a store failure while adding a roster member is the typed StoreUnavailable", () =>
    Effect.gen(function* () {
      const orgs = yield* OrganizationRecords.OrganizationRecords;
      const members = yield* MembershipRecords.MembershipRecords;
      const teams = yield* OrganizationTeams.OrganizationTeams;
      const sql = yield* SqlClient.SqlClient;
      const org = yield* orgs.create({ name: "Acme", slug: "acme" });
      yield* members.create({ userId: userId("u1"), organizationId: org.id, role: ["member"] });
      yield* TestSql.injectFailure({
        name: "fail_team_membership_insert",
        table: "organization_team_membership",
        event: "INSERT",
      });
      const failure = yield* teams
        .create(application, {
          organizationId: org.id,
          name: "Eng",
          initialMembers: [userId("u1")],
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      assert.strictEqual(yield* countRows(sql, "organization_team"), 0);
    }).pipe(Effect.provide(SqlSystemLive)),
  );
});
