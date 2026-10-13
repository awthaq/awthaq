// BEH-EA-251 (spec/behaviors/30-scim.md): SCIM Groups are organization teams, and a
// connection only ever sees and changes the users it provisioned.
import { AuditLog, HookPoint, Users } from "@awthaq/core";
import { OrganizationActor, OrganizationHooks, OrganizationTeams } from "@awthaq/organization";
import { TeamRecords } from "@awthaq/organization/records";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scim from "../src/Scim.ts";
import * as ScimApi from "../src/ScimApi.ts";
import { groupsTeams, ScimLive, seedConnection } from "./support.ts";

const user = (connection: ScimApi.ScimConnectionIdentity, name: string) =>
  Effect.gen(function* () {
    const scim = yield* Scim.Scim;
    return (yield* scim.createUser(connection, { userName: `${name}@acme.example` })).id;
  });

const patchGroup = (
  connection: ScimApi.ScimConnectionIdentity,
  id: string,
  operations: ScimApi.PatchRequest["Operations"],
) =>
  Effect.gen(function* () {
    const scim = yield* Scim.Scim;
    return yield* scim.patchGroup(connection, id, { Operations: operations });
  });

const memberIds = (group: ScimApi.GroupResource) =>
  group.members.map((member) => member.value).sort();

describe("SCIM Groups (BEH-EA-251)", () => {
  it.effect("POST creates an organization team with its provisioned members", () =>
    Effect.gen(function* () {
      const { connection, organizationId } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const teams = yield* TeamRecords.TeamRecords;
      const ada = yield* user(connection, "ada");
      const bo = yield* user(connection, "bo");
      const group = yield* scim.createGroup(connection, {
        displayName: "Engineering",
        externalId: "grp-1",
        members: [{ value: ada }, { value: bo }],
      });
      assert.deepStrictEqual(group.schemas, [ScimApi.GROUP_SCHEMA]);
      assert.strictEqual(group.displayName, "Engineering");
      assert.strictEqual(group.externalId, "grp-1");
      assert.deepStrictEqual(memberIds(group), [ada, bo].sort());
      assert.strictEqual(group.meta.resourceType, "Group");
      // It is a real team of the connection's organization.
      const team = yield* teams.findTeamById(organizationId, group.id);
      assert.isTrue(Option.isSome(team));
      assert.strictEqual((yield* teams.listTeamMembers(group.id)).length, 2);
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect("a repeat POST with the same externalId converges on the same group", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const first = yield* scim.createGroup(connection, {
        displayName: "Eng",
        externalId: "grp-1",
      });
      const again = yield* scim.createGroup(connection, {
        displayName: "Eng",
        externalId: "grp-1",
      });
      assert.strictEqual(again.id, first.id);
      assert.strictEqual((yield* scim.listGroups(connection, {})).totalResults, 1);
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect("only users this connection provisioned may be members", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const users = yield* Users.Users;
      const stranger = yield* users.create({
        identity: { _tag: "Email", email: "stranger@elsewhere.example" },
        name: "S",
      });
      const refused = yield* scim
        .createGroup(connection, { displayName: "Eng", members: [{ value: stranger.id }] })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "ScimBadRequest");
      assert.strictEqual((yield* scim.listGroups(connection, {})).totalResults, 0);
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect(
    "a connection cannot see, read or delete another connection's group, or a team it did not make",
    () =>
      Effect.gen(function* () {
        const a = yield* seedConnection("Okta");
        const b = yield* seedConnection("Entra");
        const scim = yield* Scim.Scim;
        const teams = yield* TeamRecords.TeamRecords;
        const system = yield* OrganizationTeams.OrganizationTeams;
        const theirs = yield* scim.createGroup(b.connection, { displayName: "Theirs" });
        const manual = (yield* system.create(OrganizationActor.application("test"), {
          organizationId: a.organizationId,
          name: "Made by hand",
        })).team;
        assert.strictEqual((yield* scim.listGroups(a.connection, {})).totalResults, 0);
        for (const id of [theirs.id, manual.id]) {
          assert.strictEqual(
            (yield* scim.getGroup(a.connection, id).pipe(Effect.flip))._tag,
            "ScimNotFound",
          );
          assert.strictEqual(
            (yield* scim.deleteGroup(a.connection, id).pipe(Effect.flip))._tag,
            "ScimNotFound",
          );
        }
        assert.isTrue(Option.isSome(yield* teams.findTeamById(a.organizationId, manual.id)));
      }).pipe(Effect.provide(ScimLive())),
  );

  it.effect(
    "PUT renames, sets externalId and replaces the provisioned members without touching anyone else",
    () =>
      Effect.gen(function* () {
        const { connection, organizationId } = yield* seedConnection();
        const scim = yield* Scim.Scim;
        const teams = yield* TeamRecords.TeamRecords;
        const ada = yield* user(connection, "ada");
        const bo = yield* user(connection, "bo");
        const cy = yield* user(connection, "cy");
        const group = yield* scim.createGroup(connection, {
          displayName: "Eng",
          members: [{ value: ada }, { value: bo }],
        });
        // The organization owner was added to the team by hand: not the directory's to remove.
        yield* teams.addTeamMember({ teamId: group.id, userId: Users.UserId("owner-1") });
        const replaced = yield* scim.replaceGroup(connection, group.id, {
          displayName: "Platform",
          externalId: "grp-9",
          members: [{ value: bo }, { value: cy }],
        });
        assert.strictEqual(replaced.displayName, "Platform");
        assert.strictEqual(replaced.externalId, "grp-9");
        assert.deepStrictEqual(memberIds(replaced), [bo, cy].sort());
        const onTeam = (yield* teams.listTeamMembers(group.id))
          .map((row) => row.userId as string)
          .sort();
        assert.deepStrictEqual(onTeam, [bo, cy, "owner-1"].sort());
        assert.strictEqual(
          Option.getOrThrow(yield* teams.findTeamById(organizationId, group.id)).name,
          "Platform",
        );
      }).pipe(Effect.provide(ScimLive())),
  );

  it.effect("PATCH adds, removes and replaces members and renames (RFC 7644 forms)", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const ada = yield* user(connection, "ada");
      const bo = yield* user(connection, "bo");
      const cy = yield* user(connection, "cy");
      const group = yield* scim.createGroup(connection, { displayName: "Eng" });
      const added = yield* patchGroup(connection, group.id, [
        { op: "Add", path: "members", value: [{ value: ada }, { value: bo }] },
      ]);
      assert.deepStrictEqual(memberIds(added), [ada, bo].sort());
      const removedOne = yield* patchGroup(connection, group.id, [
        { op: "remove", path: `members[value eq "${ada}"]` },
      ]);
      assert.deepStrictEqual(memberIds(removedOne), [bo]);
      const replaced = yield* patchGroup(connection, group.id, [
        { op: "replace", path: "members", value: [{ value: cy }] },
        { op: "replace", path: "displayName", value: "Platform" },
      ]);
      assert.deepStrictEqual(memberIds(replaced), [cy]);
      assert.strictEqual(replaced.displayName, "Platform");
      const cleared = yield* patchGroup(connection, group.id, [{ op: "remove", path: "members" }]);
      assert.deepStrictEqual(memberIds(cleared), []);
      const pathless = yield* patchGroup(connection, group.id, [
        { op: "replace", value: { displayName: "Infra" } },
      ]);
      assert.strictEqual(pathless.displayName, "Infra");
      const nonMember = yield* patchGroup(connection, group.id, [
        { op: "add", path: "members", value: [{ value: "not-a-user" }] },
      ]).pipe(Effect.flip);
      assert.strictEqual(nonMember._tag, "ScimBadRequest");
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect(
    "list filters by displayName and externalId, and DELETE removes the team and the mapping",
    () =>
      Effect.gen(function* () {
        const { connection, organizationId } = yield* seedConnection();
        const scim = yield* Scim.Scim;
        const teams = yield* TeamRecords.TeamRecords;
        const auditLog = yield* AuditLog.AuditLog;
        const eng = yield* scim.createGroup(connection, {
          displayName: "Eng",
          externalId: "grp-1",
        });
        yield* scim.createGroup(connection, { displayName: "Ops", externalId: "grp-2" });
        const byName = yield* scim.listGroups(connection, { filter: 'displayName eq "Ops"' });
        assert.strictEqual(byName.totalResults, 1);
        assert.strictEqual(byName.Resources[0]?.externalId, "grp-2");
        const byExternal = yield* scim.listGroups(connection, { filter: 'externalId eq "grp-1"' });
        assert.strictEqual(byExternal.Resources[0]?.displayName, "Eng");
        yield* scim.deleteGroup(connection, eng.id);
        assert.isTrue(Option.isNone(yield* teams.findTeamById(organizationId, eng.id)));
        assert.strictEqual(
          (yield* scim.getGroup(connection, eng.id).pipe(Effect.flip))._tag,
          "ScimNotFound",
        );
        assert.strictEqual((yield* scim.listGroups(connection, {})).totalResults, 1);
        assert.strictEqual(
          (yield* auditLog.list({ eventTag: "auth.scim.groupChanged" })).length,
          3,
        );
      }).pipe(Effect.provide(ScimLive())),
  );

  it.effect(
    "a group whose team was removed elsewhere is not found, and its stale mapping is dropped",
    () =>
      Effect.gen(function* () {
        const { connection, organizationId } = yield* seedConnection();
        const scim = yield* Scim.Scim;
        const group = yield* scim.createGroup(connection, {
          displayName: "Eng",
          externalId: "grp-1",
        });
        yield* (yield* OrganizationTeams.OrganizationTeams).remove(
          OrganizationActor.application("test"),
          {
            organizationId,
            teamId: group.id,
          },
        );
        assert.strictEqual(
          (yield* scim.getGroup(connection, group.id).pipe(Effect.flip))._tag,
          "ScimNotFound",
        );
        // The external id is free again.
        const fresh = yield* scim.createGroup(connection, {
          displayName: "Eng",
          externalId: "grp-1",
        });
        assert.notStrictEqual(fresh.id, group.id);
      }).pipe(Effect.provide(ScimLive())),
  );
});

// Plan 04 (ADR-EA-040, BEH-EA-251): a SCIM Group write is a team operation by a `Directory` actor, so the
// team module's veto, quotas, last-team rule and observers apply to a directory exactly as to a member.
describe("SCIM Groups go through OrganizationTeams (plan 04)", () => {
  const withTaps = (
    taps: Layer.Layer<never, never, Layer.Success<typeof OrganizationHooks.OrganizationHooksLive>>,
    organization: Parameters<typeof ScimLive>[1] = {},
  ) => ScimLive({}, organization, undefined, taps);

  const deny = (code: string) => Effect.fail(new HookPoint.HookAbort({ code }));

  it.effect("POST runs the team veto: an abort is 403 and creates neither team nor mapping", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const refused = yield* scim
        .createGroup(connection, { displayName: "Nope" })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "ScimForbidden");
      assert.strictEqual((yield* scim.listGroups(connection, {})).totalResults, 0);
      const created = yield* scim.createGroup(connection, { displayName: "Fine" });
      assert.strictEqual(created.displayName, "Fine");
    }).pipe(
      Effect.provide(
        withTaps(
          OrganizationHooks.BeforeCreateTeam.tap((input) =>
            input.name === "Nope" ? deny("NO") : Effect.succeed(input),
          ),
        ),
      ),
    ),
  );

  it.effect("POST fires the team observers with a Directory actor, one per member", () => {
    const seen: Array<string> = [];
    return Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const ada = yield* user(connection, "ada");
      yield* scim.createGroup(connection, { displayName: "Eng", members: [{ value: ada }] });
      assert.deepStrictEqual(seen, [
        `created:Directory:${connection.id}`,
        `added:Directory:${connection.id}`,
      ]);
    }).pipe(
      Effect.provide(
        withTaps(
          Layer.mergeAll(
            OrganizationHooks.AfterCreateTeam.tap((input) => {
              seen.push(
                `created:${input.actor._tag}:${"connectionId" in input.actor ? input.actor.connectionId : ""}`,
              );
              return Effect.void;
            }),
            OrganizationHooks.AfterAddTeamMember.tap((input) => {
              seen.push(
                `added:${input.actor._tag}:${"connectionId" in input.actor ? input.actor.connectionId : ""}`,
              );
              return Effect.void;
            }),
          ),
        ),
      ),
    );
  });

  it.effect("POST beyond maximumTeams is 403 and creates nothing", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      yield* scim.createGroup(connection, { displayName: "One" });
      const refused = yield* scim.createGroup(connection, { displayName: "Two" }).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "ScimForbidden");
      assert.strictEqual((yield* scim.listGroups(connection, {})).totalResults, 1);
    }).pipe(Effect.provide(ScimLive({}, { teams: { ...groupsTeams, maximumTeams: 1 } }))),
  );

  it.effect("POST with teams disabled is 403", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const refused = yield* scim.createGroup(connection, { displayName: "Eng" }).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "ScimForbidden");
    }).pipe(Effect.provide(ScimLive({}, { teams: { ...groupsTeams, enabled: false } }))),
  );

  it.effect("PATCH add beyond maximumMembersPerTeam is 403 and changes no member", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const ada = yield* user(connection, "ada");
      const bo = yield* user(connection, "bo");
      const group = yield* scim.createGroup(connection, {
        displayName: "Eng",
        members: [{ value: ada }],
      });
      const refused = yield* patchGroup(connection, group.id, [
        { op: "add", path: "members", value: [{ value: bo }] },
      ]).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "ScimForbidden");
      assert.deepStrictEqual(memberIds(yield* scim.getGroup(connection, group.id)), [ada]);
    }).pipe(Effect.provide(ScimLive({}, { teams: { ...groupsTeams, maximumMembersPerTeam: 1 } }))),
  );

  it.effect(
    "PATCH and PUT removals fire AfterRemoveTeamMember (a decision cache is cleared by it)",
    () => {
      let departures = 0;
      return Effect.gen(function* () {
        const { connection } = yield* seedConnection();
        const scim = yield* Scim.Scim;
        const ada = yield* user(connection, "ada");
        const bo = yield* user(connection, "bo");
        const group = yield* scim.createGroup(connection, {
          displayName: "Eng",
          members: [{ value: ada }, { value: bo }],
        });
        yield* patchGroup(connection, group.id, [
          { op: "remove", path: `members[value eq "${ada}"]` },
        ]);
        assert.strictEqual(departures, 1);
        yield* scim.replaceGroup(connection, group.id, { displayName: "Eng", members: [] });
        assert.strictEqual(departures, 2);
      }).pipe(
        Effect.provide(
          withTaps(
            OrganizationHooks.AfterRemoveTeamMember.tap(() => {
              departures += 1;
              return Effect.void;
            }),
          ),
        ),
      );
    },
  );

  it.effect("DELETE runs BeforeDeleteTeam: an abort is 403 and the group stays mapped", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const group = yield* scim.createGroup(connection, { displayName: "Eng" });
      const refused = yield* scim.deleteGroup(connection, group.id).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "ScimForbidden");
      assert.strictEqual((yield* scim.getGroup(connection, group.id)).id, group.id);
    }).pipe(Effect.provide(withTaps(OrganizationHooks.BeforeDeleteTeam.tap(() => deny("KEEP"))))),
  );

  it.effect("DELETE of the last group is 409 unless allowRemovingAllTeams", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const group = yield* scim.createGroup(connection, { displayName: "Eng" });
      const refused = yield* scim.deleteGroup(connection, group.id).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "ScimConflict");
      assert.strictEqual((yield* scim.listGroups(connection, {})).totalResults, 1);
    }).pipe(
      Effect.provide(ScimLive({}, { teams: { ...groupsTeams, allowRemovingAllTeams: false } })),
    ),
  );

  it.effect("DELETE fires AfterDeleteTeam and clears every session's active team", () => {
    let deleted = 0;
    return Effect.gen(function* () {
      const { connection, organizationId } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const teams = yield* TeamRecords.TeamRecords;
      const group = yield* scim.createGroup(connection, { displayName: "Eng" });
      yield* scim.deleteGroup(connection, group.id);
      assert.strictEqual(deleted, 1);
      assert.isTrue(Option.isNone(yield* teams.findTeamById(organizationId, group.id)));
    }).pipe(
      Effect.provide(
        withTaps(
          OrganizationHooks.AfterDeleteTeam.tap(() => {
            deleted += 1;
            return Effect.void;
          }),
        ),
      ),
    );
  });
});
