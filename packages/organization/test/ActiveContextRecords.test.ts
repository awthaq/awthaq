// spec.md's "Active organization/team state": the same
// contract-suite-over-both-layers pattern `MembershipRecords.test.ts` uses.
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";

const MemoryLayer = ActiveContextRecords.layerMemory;

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE organization_active_context (
        sessionId TEXT PRIMARY KEY,
        activeOrganizationId TEXT,
        activeTeamId TEXT,
        updatedAt TEXT NOT NULL
      )
    `;
  }),
).pipe(Layer.provide(SqlLive));

const SqlLayer = ActiveContextRecords.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const suite = (
  name: string,
  layer: Layer.Layer<ActiveContextRecords.ActiveContextRecords, unknown, never>,
): void => {
  describe(name, () => {
    it.effect("setOrganization then findBySessionId round-trips it", () =>
      Effect.gen(function* () {
        const records = yield* ActiveContextRecords.ActiveContextRecords;
        yield* records.setOrganization("session-1", "org-1");
        const found = yield* records.findBySessionId("session-1");
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) {
          assert.deepStrictEqual(found.value.activeOrganizationId, Option.some("org-1"));
          assert.deepStrictEqual(found.value.activeTeamId, Option.none());
        }
      }).pipe(Effect.provide(layer)),
    );

    it.effect("setOrganization with null unsets it without touching activeTeamId", () =>
      Effect.gen(function* () {
        const records = yield* ActiveContextRecords.ActiveContextRecords;
        yield* records.setOrganization("session-1", "org-1");
        yield* records.setTeam("session-1", "team-1");
        yield* records.setOrganization("session-1", null);
        const found = yield* records.findBySessionId("session-1");
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) {
          assert.deepStrictEqual(found.value.activeOrganizationId, Option.none());
          assert.deepStrictEqual(found.value.activeTeamId, Option.some("team-1"));
        }
      }).pipe(Effect.provide(layer)),
    );

    it.effect("setTeam independently of setOrganization", () =>
      Effect.gen(function* () {
        const records = yield* ActiveContextRecords.ActiveContextRecords;
        yield* records.setTeam("session-2", "team-9");
        const found = yield* records.findBySessionId("session-2");
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) {
          assert.deepStrictEqual(found.value.activeTeamId, Option.some("team-9"));
          assert.deepStrictEqual(found.value.activeOrganizationId, Option.none());
        }
      }).pipe(Effect.provide(layer)),
    );

    it.effect("findBySessionId answers none for an unknown session", () =>
      Effect.gen(function* () {
        const records = yield* ActiveContextRecords.ActiveContextRecords;
        const found = yield* records.findBySessionId("no-such-session");
        assert.isTrue(Option.isNone(found));
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("ActiveContextRecords (layerMemory)", MemoryLayer);
suite("ActiveContextRecords (layerSql)", SqlLayer);
