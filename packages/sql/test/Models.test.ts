// TS-001 (wayfinder ticket 29): `makeModels(dialect)` selects the database
// variants' boolean/DateTime wire codecs per dialect. These cases need no
// server — they feed each dialect's model the row shape its driver actually
// returns (`@effect/sql-pg`: JS `boolean`/`Date`; `node:sqlite`: `0 | 1` and
// ISO strings) — so the Postgres field variants are exercised even where
// `AWTHAQ_POSTGRES_URL` is unset. `Repositories.postgres.test.ts` is the
// real-server counterpart.
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Models from "../src/Models.ts";

const pg = Models.makeModels("pg");
const sqlite = Models.makeModels("sqlite");

const at = DateTime.makeUnsafe("2026-01-02T03:04:05.006Z");
const iso = "2026-01-02T03:04:05.006Z";
const date = new Date(iso);

describe("Models.makeModels (TS-001)", () => {
  it.effect("pg User decodes a driver-shaped row (boolean, Date)", () =>
    Effect.gen(function* () {
      const user = yield* Schema.decodeUnknownEffect(pg.User)({
        id: "u1",
        email: "a@example.com",
        emailVerified: true,
        name: "A",
        metadata: null,
        phone: null,
        phoneVerified: false,
        image: null,
        status: "active",
        statusReason: null,
        tenantId: null,
        suspendedUntil: null,
        createdAt: date,
        updatedAt: date,
      });
      assert.strictEqual(user.emailVerified, true);
      assert.isTrue(DateTime.Equivalence(user.createdAt, at));
    }),
  );

  it.effect("sqlite User decodes a driver-shaped row (bit, ISO string)", () =>
    Effect.gen(function* () {
      const user = yield* Schema.decodeUnknownEffect(sqlite.User)({
        id: "u1",
        email: "a@example.com",
        emailVerified: 1,
        name: "A",
        metadata: null,
        phone: null,
        phoneVerified: 0,
        image: null,
        status: "active",
        statusReason: null,
        tenantId: null,
        suspendedUntil: null,
        createdAt: iso,
        updatedAt: iso,
      });
      assert.strictEqual(user.emailVerified, true);
      assert.isTrue(DateTime.Equivalence(user.updatedAt, at));
    }),
  );

  it.effect("each dialect's model rejects the other driver's row shape", () =>
    Effect.gen(function* () {
      const pgRow = {
        id: "u1",
        email: "a@example.com",
        emailVerified: true,
        name: "A",
        metadata: null,
        phone: null,
        phoneVerified: false,
        image: null,
        status: "active",
        statusReason: null,
        tenantId: null,
        suspendedUntil: null,
        createdAt: date,
        updatedAt: date,
      };
      // The pre-TS-001 (SQLite-only) model against a pg row: the defect.
      const wrong = yield* Effect.exit(Schema.decodeUnknownEffect(sqlite.User)(pgRow));
      assert.isTrue(Exit.isFailure(wrong));
      const wrongTheOtherWay = yield* Effect.exit(
        Schema.decodeUnknownEffect(pg.User)({
          ...pgRow,
          emailVerified: 1,
          createdAt: iso,
          updatedAt: iso,
        }),
      );
      assert.isTrue(Exit.isFailure(wrongTheOtherWay));
    }),
  );

  it.effect("pg Session decodes nullable timestamps as Date | null", () =>
    Effect.gen(function* () {
      const session = yield* Schema.decodeUnknownEffect(pg.Session)({
        id: "s1",
        userId: "u1",
        secretHash: "h",
        ipAddress: null,
        userAgent: null,
        absoluteExpiresAt: date,
        idleExpiresAt: date,
        createdAt: date,
        authenticatedAt: date,
        lastActiveAt: date,
        actingAsType: null,
        actingAsId: null,
        familyId: "s1",
        supersededBy: null,
        supersededAt: null,
        reusedAt: date,
        amr: "[]",
        tenantId: null,
      });
      assert.strictEqual(session.supersededAt, null);
      assert.isNotNull(session.reusedAt);
    }),
  );

  it.effect("pg VerificationToken and VerificationReservation decode Date timestamps", () =>
    Effect.gen(function* () {
      const token = yield* Schema.decodeUnknownEffect(pg.VerificationToken)({
        id: "t1",
        identifier: "verify-email:u1",
        userId: null,
        tenantId: null,
        valueHash: "h",
        expiresAt: date,
        consumedAt: null,
        createdAt: date,
        payload: "null",
        maxAttempts: null,
        attempts: 0,
      });
      assert.strictEqual(token.consumedAt, null);
      const reservation = yield* Schema.decodeUnknownEffect(pg.VerificationReservation)({
        identifier: "x",
        tenantId: null,
        expiresAt: date,
      });
      assert.isTrue(DateTime.Equivalence(reservation.expiresAt, at));
    }),
  );

  it.effect("insert variants encode to each driver's bind type", () =>
    Effect.gen(function* () {
      const pgInsert = yield* pg.User.insert.makeEffect({ email: "a@example.com", name: "A" });
      const pgEncoded = yield* Schema.encodeEffect(pg.User.insert)(pgInsert);
      assert.strictEqual(pgEncoded.emailVerified, false);
      assert.instanceOf(pgEncoded.createdAt, Date);

      const sqliteInsert = yield* sqlite.User.insert.makeEffect({
        email: "a@example.com",
        name: "A",
      });
      const sqliteEncoded = yield* Schema.encodeEffect(sqlite.User.insert)(sqliteInsert);
      assert.strictEqual(sqliteEncoded.emailVerified, 0);
      assert.strictEqual(typeof sqliteEncoded.createdAt, "string");
    }),
  );

  it.effect("json variants encode identically across dialects", () =>
    Effect.gen(function* () {
      const pgUser = yield* Schema.decodeUnknownEffect(pg.User)({
        id: "u1",
        email: "a@example.com",
        emailVerified: true,
        name: "A",
        metadata: null,
        phone: null,
        phoneVerified: false,
        image: null,
        status: "active",
        statusReason: null,
        tenantId: null,
        suspendedUntil: null,
        createdAt: date,
        updatedAt: date,
      });
      const sqliteUser = yield* Schema.decodeUnknownEffect(sqlite.User)({
        id: "u1",
        email: "a@example.com",
        emailVerified: 1,
        name: "A",
        metadata: null,
        phone: null,
        phoneVerified: 0,
        image: null,
        status: "active",
        statusReason: null,
        tenantId: null,
        suspendedUntil: null,
        createdAt: iso,
        updatedAt: iso,
      });
      const fromPg = yield* Schema.encodeUnknownEffect(pg.User.json)(pgUser);
      const fromSqlite = yield* Schema.encodeUnknownEffect(sqlite.User.json)(sqliteUser);
      assert.deepStrictEqual(fromPg, fromSqlite);
      assert.strictEqual(fromPg.createdAt, iso);
      assert.strictEqual(fromPg.emailVerified, true);
    }),
  );

  it.effect("dialectFields exposes the plain wire codecs for record stores", () =>
    Effect.gen(function* () {
      const p = Models.dialectFields("pg");
      const s = Models.dialectFields("sqlite");
      assert.instanceOf(yield* Schema.encodeEffect(p.dateTime)(at), Date);
      assert.strictEqual(yield* Schema.encodeEffect(s.dateTime)(at), iso);
      assert.strictEqual(yield* Schema.encodeEffect(p.boolean)(true), true);
      assert.strictEqual(yield* Schema.encodeEffect(s.boolean)(true), 1);
      assert.strictEqual(yield* Schema.decodeUnknownEffect(p.nullableDateTime)(null), null);
    }),
  );
});
