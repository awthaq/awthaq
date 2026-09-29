// BAM-003 (.issues/high): proves `Sessions.verify` genuinely consults
// `LegacySessionBridge` on a primary-store miss — both the malformed-token
// branch (a still-live legacy token, which never contains a `.`) and the
// unrecognized-id branch — mints a fresh awthaq session through the same
// `issue` every other session goes through, and makes the legacy token
// single-use via `consume`. Runs against both `layerMemory` and
// `layerSql`, mirroring `Sessions.test.ts`'s own dual-layer pattern.
import { LegacySessionBridge } from "@awthaq/ports";
import { Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Sessions from "../src/Sessions.ts";
import * as Users from "../src/Users.ts";

const LEGACY_TOKEN = "legacy-opaque-better-auth-token";
const LEGACY_USER_ID = Users.UserId("legacy-user-1");

/** A fake bridge: resolves exactly `LEGACY_TOKEN` once, then reports it consumed. */
const FakeBridgeLayer = Layer.effect(
  LegacySessionBridge.LegacySessionBridge,
  Effect.sync(() => {
    const consumed = new Set<string>();
    return LegacySessionBridge.LegacySessionBridge.of({
      resolve: (rawToken) =>
        rawToken === LEGACY_TOKEN && !consumed.has(rawToken)
          ? Effect.succeed(
              Option.some({
                userId: LEGACY_USER_ID,
                ipAddress: Option.some("203.0.113.9"),
                userAgent: Option.some("legacy-agent/1.0"),
              }),
            )
          : Effect.succeedNone,
      consume: (rawToken) => Effect.sync(() => void consumed.add(rawToken)),
    });
  }),
);

const MemoryLayer = Sessions.layerMemory.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provide(AuthEvents.layer),
  Layer.provide(AuditLog.layerMemory),
  Layer.provide(FakeBridgeLayer),
);

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        secretHash TEXT NOT NULL,
        ipAddress TEXT,
        userAgent TEXT,
        absoluteExpiresAt TEXT NOT NULL,
        idleExpiresAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        authenticatedAt TEXT NOT NULL,
        lastActiveAt TEXT NOT NULL,
        actingAsType TEXT,
        actingAsId TEXT,
        familyId TEXT NOT NULL,
        supersededBy TEXT,
        supersededAt TEXT,
        reusedAt TEXT,
        amr TEXT NOT NULL DEFAULT '[]',
        tenantId TEXT
      )
    `;
  }),
).pipe(Layer.provide(SqlLive));

const SqlLayer = Sessions.layerSql.pipe(
  Layer.provide(Repositories.SessionsRepositoryLive),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(AuthEvents.layer),
  Layer.provide(AuditLog.layerMemory),
  Layer.provide(FakeBridgeLayer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const suite = (name: string, layer: Layer.Layer<Sessions.Sessions, unknown, never>): void => {
  describe(name, () => {
    it.effect("a still-live legacy token bridges into a freshly minted session, once", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const result = yield* sessions.verify(Redacted.make(LEGACY_TOKEN));
        assert.strictEqual(result.session.userId, LEGACY_USER_ID);
        assert.isTrue(Option.isSome(result.rotated));
        assert.deepStrictEqual(result.session.ipAddress, Option.some("203.0.113.9"));
        assert.deepStrictEqual(result.session.userAgent, Option.some("legacy-agent/1.0"));

        // Single-use: presenting the exact same legacy token again fails —
        // `consume` already ran, so a second bridge lookup misses too.
        const replay = yield* sessions.verify(Redacted.make(LEGACY_TOKEN)).pipe(Effect.flip);
        assert.strictEqual(replay._tag, "Sessions/NotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("an unrecognized token that isn't the bridged legacy one still fails normally", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const failure = yield* sessions
          .verify(Redacted.make("some-other-unbridgeable-token"))
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "Sessions/NotFound");
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("Sessions.layerMemory", MemoryLayer);
suite("Sessions.layerSql", SqlLayer);
