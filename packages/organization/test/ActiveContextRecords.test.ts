// spec.md's "Active organization/team state": the same
// contract-suite-over-both-layers pattern `MembershipRecords.test.ts` uses.
// `layerSql` here is migrated via `Organization.Organization`'s own real
// `migrations` (`Migrations.run`, `@awthaq/core`) rather than a hand-rolled
// inline `CREATE TABLE` — BAM-002 (.issues/high) verification, the same
// `packages/jwt/test/RevocationStore.test.ts` establishes.
//
// The setters take a witness (MTI-001): a `MembershipRecord` /
// `TeamMembershipRecord` can only come from its own records layer, so the
// suite obtains them from the memory records layers next to the layer under
// test.
import { Migrations, Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as TeamRecords from "../src/TeamRecords.ts";

const MemoryLayer = ActiveContextRecords.layerMemory;

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
  Layer.provide(SqlLive),
);

const SqlLayer = ActiveContextRecords.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const Witnesses = Layer.mergeAll(MembershipRecords.layerMemory, TeamRecords.layerMemory).pipe(
  Layer.provide(NodeCrypto.layer),
);

const alice = Users.UserId("alice");
const bob = Users.UserId("bob");

const member = (userId: Users.UserId, organizationId: string) =>
  MembershipRecords.MembershipRecords.use((records) =>
    records.create({ userId, organizationId, role: ["member"] }),
  ).pipe(Effect.orDie);

const onTeam = (userId: Users.UserId, teamId: string) =>
  TeamRecords.TeamRecords.use((records) => records.addTeamMember({ teamId, userId })).pipe(
    Effect.orDie,
  );

const suite = (
  name: string,
  layer: Layer.Layer<ActiveContextRecords.ActiveContextRecords, unknown, never>,
): void => {
  const TestLayer = Layer.mergeAll(layer, Witnesses);
  describe(name, () => {
    it.effect("setOrganization then findBySessionId round-trips it (and records the user)", () =>
      Effect.gen(function* () {
        const records = yield* ActiveContextRecords.ActiveContextRecords;
        yield* records.setOrganization("session-1", yield* member(alice, "org-1"));
        const found = yield* records.findBySessionId("session-1");
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) {
          assert.deepStrictEqual(found.value.activeOrganizationId, Option.some("org-1"));
          assert.deepStrictEqual(found.value.activeTeamId, Option.none());
          assert.deepStrictEqual(found.value.userId, Option.some("alice"));
        }
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("unsetOrganization unsets it without touching activeTeamId", () =>
      Effect.gen(function* () {
        const records = yield* ActiveContextRecords.ActiveContextRecords;
        yield* records.setOrganization("session-1", yield* member(alice, "org-1"));
        yield* records.setTeam("session-1", yield* onTeam(alice, "team-1"));
        yield* records.unsetOrganization("session-1", alice);
        const found = yield* records.findBySessionId("session-1");
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) {
          assert.deepStrictEqual(found.value.activeOrganizationId, Option.none());
          assert.deepStrictEqual(found.value.activeTeamId, Option.some("team-1"));
        }
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("setTeam independently of setOrganization; unsetTeam clears only the team", () =>
      Effect.gen(function* () {
        const records = yield* ActiveContextRecords.ActiveContextRecords;
        yield* records.setTeam("session-2", yield* onTeam(alice, "team-9"));
        const found = yield* records.findBySessionId("session-2");
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) {
          assert.deepStrictEqual(found.value.activeTeamId, Option.some("team-9"));
          assert.deepStrictEqual(found.value.activeOrganizationId, Option.none());
        }
        yield* records.unsetTeam("session-2", alice);
        const cleared = yield* records.findBySessionId("session-2");
        assert.isTrue(Option.isSome(cleared));
        if (Option.isSome(cleared))
          assert.deepStrictEqual(cleared.value.activeTeamId, Option.none());
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("findBySessionId answers none for an unknown session", () =>
      Effect.gen(function* () {
        const records = yield* ActiveContextRecords.ActiveContextRecords;
        const found = yield* records.findBySessionId("no-such-session");
        assert.isTrue(Option.isNone(found));
      }).pipe(Effect.provide(TestLayer)),
    );

    // CWM-003: the organization/team a row points at goes away.
    it.effect("clearOrganization nulls the org and team of every session on that org only", () =>
      Effect.gen(function* () {
        const records = yield* ActiveContextRecords.ActiveContextRecords;
        yield* records.setOrganization("s-a", yield* member(alice, "org-1"));
        yield* records.setTeam("s-a", yield* onTeam(alice, "team-1"));
        yield* records.setOrganization("s-b", yield* member(bob, "org-1"));
        yield* records.setOrganization("s-c", yield* member(bob, "org-2"));

        yield* records.clearOrganization("org-1");

        const a = yield* records.findBySessionId("s-a");
        const b = yield* records.findBySessionId("s-b");
        const c = yield* records.findBySessionId("s-c");
        assert.isTrue(Option.isSome(a) && Option.isNone(a.value.activeOrganizationId));
        assert.isTrue(Option.isSome(a) && Option.isNone(a.value.activeTeamId));
        assert.isTrue(Option.isSome(b) && Option.isNone(b.value.activeOrganizationId));
        assert.isTrue(
          Option.isSome(c) && Option.isSome(c.value.activeOrganizationId),
          "a session on another organization is untouched",
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("clearOrganizationForUser only touches that user's sessions on that org", () =>
      Effect.gen(function* () {
        const records = yield* ActiveContextRecords.ActiveContextRecords;
        yield* records.setOrganization("s-a", yield* member(alice, "org-1"));
        yield* records.setOrganization("s-b", yield* member(bob, "org-1"));

        yield* records.clearOrganizationForUser(alice, "org-1");

        const a = yield* records.findBySessionId("s-a");
        const b = yield* records.findBySessionId("s-b");
        assert.isTrue(Option.isSome(a) && Option.isNone(a.value.activeOrganizationId));
        assert.isTrue(Option.isSome(b) && Option.isSome(b.value.activeOrganizationId));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("clearTeam nulls activeTeamId for sessions on that team, keeping the org", () =>
      Effect.gen(function* () {
        const records = yield* ActiveContextRecords.ActiveContextRecords;
        yield* records.setOrganization("s-a", yield* member(alice, "org-1"));
        yield* records.setTeam("s-a", yield* onTeam(alice, "team-1"));
        yield* records.setTeam("s-b", yield* onTeam(bob, "team-2"));

        yield* records.clearTeam("team-1");

        const a = yield* records.findBySessionId("s-a");
        const b = yield* records.findBySessionId("s-b");
        assert.isTrue(Option.isSome(a) && Option.isNone(a.value.activeTeamId));
        assert.isTrue(Option.isSome(a) && Option.isSome(a.value.activeOrganizationId));
        assert.isTrue(Option.isSome(b) && Option.isSome(b.value.activeTeamId));
      }).pipe(Effect.provide(TestLayer)),
    );

    // DRS-008
    it.effect("deleteAllByUser removes every session row for that user only", () =>
      Effect.gen(function* () {
        const records = yield* ActiveContextRecords.ActiveContextRecords;
        yield* records.setOrganization("s-a1", yield* member(alice, "org-1"));
        yield* records.setOrganization("s-a2", yield* member(alice, "org-2"));
        yield* records.setOrganization("s-b", yield* member(bob, "org-1"));

        yield* records.deleteAllByUser(alice);

        assert.isTrue(Option.isNone(yield* records.findBySessionId("s-a1")));
        assert.isTrue(Option.isNone(yield* records.findBySessionId("s-a2")));
        assert.isTrue(Option.isSome(yield* records.findBySessionId("s-b")));
      }).pipe(Effect.provide(TestLayer)),
    );
  });
};

suite("ActiveContextRecords (layerMemory)", MemoryLayer);
suite("ActiveContextRecords (layerSql)", SqlLayer);

// MTI-001: an active-context write for a non-member is unrepresentable — the
// setters demand a record only the records layers can produce, so a
// hand-built object literal is a compile error. (Type-level only; never run.)
describe("ActiveContextRecords witnesses (type level)", () => {
  it("rejects a hand-built membership witness", () => {
    const handBuilt = {
      id: "m-1",
      userId: alice,
      organizationId: "org-1",
      role: ["owner"],
      createdAt: DateTime.nowUnsafe(),
    };
    const neverRun = (records: ActiveContextRecords.ActiveContextRecordsShape) =>
      // @ts-expect-error a plain object is not a MembershipRecord
      records.setOrganization("session-1", handBuilt);
    assert.isFunction(neverRun);
  });
});
