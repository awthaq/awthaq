// BEH-EA-251 / BEH-EA-249 (spec/behaviors/30-scim.md), architecture plan 32 ticket 02: a SCIM write is one unit of work.
// A refused PATCH/PUT leaves the team, roster and mapping as they were and publishes nothing; a deactivation commits
// the suspension and the session revocation together. Over SQL only: the memory records have no rollback (PLAN 32 §3.4).
import { AuditLog, HookPoint, Sessions, Users } from "@awthaq/core";
import { OrganizationHooks } from "@awthaq/organization";
import { TestAuth, TestSql } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Scim from "../src/Scim.ts";
import * as ScimApi from "../src/ScimApi.ts";
import { ScimLive, ScimLiveSql, seedConnection } from "./support.ts";

const SUITE = "scim_atomicity";

const vetoTap = OrganizationHooks.BeforeUpdateTeam.tap((input) =>
  input.name === "Vetoed"
    ? Effect.fail(new HookPoint.HookAbort({ code: "NO" }))
    : Effect.succeed(input),
);

const provision = (connection: ScimApi.ScimConnectionIdentity, name: string) =>
  Effect.flatMap(Scim.Scim, (scim) =>
    scim.createUser(connection, { userName: `${name}@acme.example` }),
  );

const patchGroup = (
  connection: ScimApi.ScimConnectionIdentity,
  id: string,
  operations: ScimApi.PatchRequest["Operations"],
) =>
  Effect.flatMap(Scim.Scim, (scim) => scim.patchGroup(connection, id, { Operations: operations }));

const auditCount = (eventTag: string) =>
  Effect.flatMap(AuditLog.AuditLog, (log) => log.list({ eventTag })).pipe(
    Effect.map((rows) => rows.length),
  );

type Taps = Parameters<typeof ScimLive>[3];

const modes = [
  ["memory", (taps?: Taps) => ScimLive({}, {}, undefined, taps)],
  ["SQL", (taps?: Taps) => ScimLiveSql(SUITE, {}, taps)],
] as const;

for (const [label, layer] of modes) {
  describe(`a refused SCIM write changes nothing (${label})`, () => {
    it.effect(
      "A1: a PATCH whose later operation fails leaves the rename undone and unannounced",
      () =>
        Effect.gen(function* () {
          const { connection } = yield* seedConnection("a1");
          const scim = yield* Scim.Scim;
          const group = yield* scim.createGroup(connection, { displayName: "Eng" });
          const failure = yield* patchGroup(connection, group.id, [
            { op: "replace", path: "displayName", value: "Platform" },
            { op: "add", path: "members", value: [{ value: "not-a-user" }] },
          ]).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "ScimBadRequest");
          const after = yield* scim.getGroup(connection, group.id);
          assert.strictEqual(after.displayName, "Eng");
          assert.strictEqual(yield* auditCount("auth.organization.teamUpdated"), 0);
        }).pipe(Effect.provide(layer())),
    );

    it.effect("A2: an unknown op after a member add leaves the roster empty", () =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection("a2");
        const scim = yield* Scim.Scim;
        const ada = (yield* provision(connection, "ada")).id;
        const group = yield* scim.createGroup(connection, { displayName: "Eng" });
        const failure = yield* patchGroup(connection, group.id, [
          { op: "add", path: "members", value: [{ value: ada }] },
          { op: "frobnicate", path: "displayName", value: "X" },
        ]).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "ScimBadRequest");
        assert.deepStrictEqual((yield* scim.getGroup(connection, group.id)).members, []);
      }).pipe(Effect.provide(layer())),
    );

    it.effect("A3: a later empty displayName undoes the earlier rename", () =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection("a3");
        const scim = yield* Scim.Scim;
        const group = yield* scim.createGroup(connection, { displayName: "Eng" });
        const failure = yield* patchGroup(connection, group.id, [
          { op: "replace", path: "displayName", value: "Platform" },
          { op: "replace", path: "displayName", value: "" },
        ]).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "ScimBadRequest");
        assert.strictEqual((yield* scim.getGroup(connection, group.id)).displayName, "Eng");
      }).pipe(Effect.provide(layer())),
    );

    it.effect("A4: a vetoed PUT keeps the old externalId and name", () =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection("a4");
        const scim = yield* Scim.Scim;
        const group = yield* scim.createGroup(connection, {
          displayName: "Eng",
          externalId: "grp-1",
        });
        const failure = yield* scim
          .replaceGroup(connection, group.id, {
            displayName: "Vetoed",
            externalId: "grp-2",
            members: [],
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "ScimForbidden");
        const after = yield* scim.getGroup(connection, group.id);
        assert.strictEqual(after.externalId, "grp-1");
        assert.strictEqual(after.displayName, "Eng");
      }).pipe(Effect.provide(layer(vetoTap))),
    );

    it.effect("A6: a path-less PATCH object applies every attribute, not just the first", () =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection("a6");
        const scim = yield* Scim.Scim;
        const ada = (yield* provision(connection, "ada")).id;
        const group = yield* scim.createGroup(connection, { displayName: "Eng" });
        const patched = yield* patchGroup(connection, group.id, [
          { op: "replace", value: { displayName: "Platform", members: [{ value: ada }] } },
        ]);
        assert.strictEqual(patched.displayName, "Platform");
        assert.deepStrictEqual(patched.members, [{ value: ada }]);
        const again = yield* patchGroup(connection, group.id, [
          { op: "replace", value: { externalId: "grp-9" } },
        ]);
        assert.strictEqual(again.externalId, "grp-9");
      }).pipe(Effect.provide(layer())),
    );

    it.effect("A8: operations in one PATCH are one net roster change, one event per user", () =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection("a8");
        const scim = yield* Scim.Scim;
        const ada = (yield* provision(connection, "ada")).id;
        const bo = (yield* provision(connection, "bo")).id;
        const group = yield* scim.createGroup(connection, { displayName: "Eng" });
        const patched = yield* patchGroup(connection, group.id, [
          { op: "add", path: "members", value: [{ value: ada }] },
          { op: "add", path: "members", value: [{ value: bo }] },
          { op: "replace", path: "members", value: [{ value: bo }] },
        ]);
        assert.deepStrictEqual(patched.members, [{ value: bo }]);
        assert.strictEqual(yield* auditCount("auth.organization.teamMemberAdded"), 1);
      }).pipe(Effect.provide(layer())),
    );
  });
}

describe("a SCIM write is one unit of work (SQL only: memory has no rollback or outages)", () => {
  it.effect("A5: a vetoed rename after a member add leaves no member and no event", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection("a5");
      const scim = yield* Scim.Scim;
      const ada = (yield* provision(connection, "ada")).id;
      const group = yield* scim.createGroup(connection, { displayName: "Eng" });
      const failure = yield* patchGroup(connection, group.id, [
        { op: "add", path: "members", value: [{ value: ada }] },
        { op: "replace", path: "displayName", value: "Vetoed" },
      ]).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "ScimForbidden");
      assert.deepStrictEqual((yield* scim.getGroup(connection, group.id)).members, []);
      assert.strictEqual(yield* auditCount("auth.organization.teamMemberAdded"), 0);
    }).pipe(Effect.provide(ScimLiveSql(SUITE, {}, vetoTap))),
  );

  it.effect("A7: a session-revocation outage keeps the user active; the retry completes both", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection("a7");
      const sessions = yield* Sessions.Sessions;
      const users = yield* Users.Users;
      const sql = yield* SqlClient.SqlClient;
      const created = yield* provision(connection, "ada");
      const id = Users.UserId(created.id);
      const session = yield* sessions.issue({ userId: id });
      yield* TestSql.injectFailure({
        name: "fail_sessions_delete",
        table: "sessions",
        event: "DELETE",
      });
      const scim = yield* Scim.Scim;
      const failure = yield* scim
        .patchUser(connection, created.id, {
          Operations: [{ op: "replace", path: "active", value: false }],
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      assert.strictEqual((yield* users.findById(id)).status, "active");
      assert.strictEqual((yield* sessions.verify(session.token)).session.userId, id);
      yield* sql.onDialectOrElse({
        pg: () => sql.unsafe("DROP TRIGGER fail_sessions_delete ON sessions"),
        orElse: () => sql.unsafe("DROP TRIGGER fail_sessions_delete"),
      });
      yield* scim.patchUser(connection, created.id, {
        Operations: [{ op: "replace", path: "active", value: false }],
      });
      assert.strictEqual((yield* users.findById(id)).status, "suspended");
      assert.strictEqual(
        (yield* sessions.verify(session.token).pipe(Effect.flip))._tag,
        "Sessions/NotFound",
      );
    }).pipe(TestAuth.withoutRequest, Effect.provide(ScimLiveSql(SUITE))),
  );
});
