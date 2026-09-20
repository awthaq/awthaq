// spec/behaviors/08-verification-tokens.md, BEH-EA-057 through BEH-EA-064.
//
// The same contract suite runs against both `Layer`s — `layerMemory` (a
// `Ref`) and `layerSql` (a real, in-memory SQLite database via
// `@effect/sql-sqlite-node`) — per
// spec/decisions/016-verification-sql-claiming.md (ADR-EA-016).
import { Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Verification from "../src/Verification.ts";

const MemoryLayer = Verification.layerMemory.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
);

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE verification_tokens (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL,
        valueHash TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        consumedAt TEXT,
        createdAt TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE UNIQUE INDEX verification_tokens_live_identifier
      ON verification_tokens(identifier) WHERE consumedAt IS NULL
    `;
    yield* sql`
      CREATE TABLE verification_reservations (
        identifier TEXT PRIMARY KEY,
        expiresAt TEXT NOT NULL
      )
    `;
  }),
).pipe(Layer.provide(SqlLive));

const SqlLayer = Verification.layerSql.pipe(
  Layer.provide(Repositories.VerificationRepositoryLive),
  Layer.provide(Repositories.VerificationReservationsRepositoryLive),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const suite = (
  name: string,
  layer: Layer.Layer<Verification.Verification | AuthEvents.AuthEvents, unknown, never>,
): void => {
  describe(name, () => {
    it.effect(
      "BEH-EA-057/060: a token is scoped to one purpose-encoded identifier, hashed at rest",
      () =>
        Effect.gen(function* () {
          const verification = yield* Verification.Verification;
          const identifier = "verify-email:user-1";
          const { token, value } = yield* verification.issue({
            identifier,
            ttl: Duration.minutes(10),
          });
          assert.strictEqual(token.identifier, identifier);
          assert.notStrictEqual(Redacted.value(value), token.id);
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "BEH-EA-122 (@awthaq/oauth): an opaque payload round-trips through issue/consume verbatim",
      () =>
        Effect.gen(function* () {
          const verification = yield* Verification.Verification;
          const identifier = "oauth.flow:abc";
          const payload = { codeVerifier: "v", nonce: "n", callbackURL: "/dashboard" };
          const { value } = yield* verification.issue({
            identifier,
            ttl: Duration.minutes(10),
            payload,
          });
          const consumed = yield* verification.consume(identifier, value);
          assert.deepStrictEqual(consumed.payload, payload);
        }).pipe(Effect.provide(layer)),
    );

    it.effect("issuing with no payload leaves it undefined on consume", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const identifier = "verify-email:user-9";
        const { value } = yield* verification.issue({ identifier, ttl: Duration.minutes(10) });
        const consumed = yield* verification.consume(identifier, value);
        assert.isUndefined(consumed.payload);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-058/062: consuming succeeds exactly once, and a replay is refused", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const identifier = "reset-password:user-1";
        const { value } = yield* verification.issue({ identifier, ttl: Duration.minutes(10) });

        const consumed = yield* verification.consume(identifier, value);
        assert.strictEqual(consumed.identifier, identifier);

        const replay = yield* verification.consume(identifier, value).pipe(Effect.flip);
        assert.strictEqual(replay._tag, "TokenConsumed");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-059: an unknown identifier fails with the same TokenConsumed error", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const bogus = Redacted.make("does-not-exist");
        const failure = yield* verification.consume("verify-email:nobody", bogus).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "TokenConsumed");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-059: every failed consumption publishes auth.token.replay", () =>
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        const verification = yield* Verification.Verification;
        // `startImmediately` runs the forked fiber synchronously up to its own
        // first suspension point (inside the PubSub subscribe, waiting for a
        // published item) before this call returns — without it, the fork is
        // merely scheduled, and publishing below could race a subscription
        // that hasn't registered with the PubSub yet.
        const replayed = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter((event) => event._tag === "auth.token.replay"),
            Stream.take(2),
            Stream.runCollect,
          ),
          { startImmediately: true },
        );

        const { value } = yield* verification.issue({
          identifier: "verify-email:user-5",
          ttl: Duration.minutes(10),
        });
        yield* verification.consume("verify-email:user-5", value);
        // Already consumed: a replay.
        yield* verification.consume("verify-email:user-5", value).pipe(Effect.ignore);
        // Never existed at all: also a replay, per BEH-EA-059's uniform treatment.
        yield* verification.consume("verify-email:nobody", Redacted.make("x")).pipe(Effect.ignore);

        const collected = yield* Fiber.join(replayed);
        assert.strictEqual(collected.length, 2);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-061: an expired token is refused even though the row hasn't been swept", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const identifier = "verify-email:user-2";
        const { value } = yield* verification.issue({ identifier, ttl: Duration.millis(10) });
        yield* TestClock.adjust(Duration.millis(20));
        const failure = yield* verification.consume(identifier, value).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "TokenConsumed");
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "ADR-EA-016: issuing a fresh token for the same identifier invalidates the prior one",
      () =>
        Effect.gen(function* () {
          const verification = yield* Verification.Verification;
          const identifier = "verify-email:user-10";
          const first = yield* verification.issue({ identifier, ttl: Duration.minutes(10) });
          yield* verification.issue({ identifier, ttl: Duration.minutes(10) });
          const failure = yield* verification.consume(identifier, first.value).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "TokenConsumed");
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "ADR-EA-016: two concurrent issues for the same identifier leave exactly one consumable token",
      () =>
        Effect.gen(function* () {
          const verification = yield* Verification.Verification;
          const identifier = "verify-email:user-12";
          const [a, b] = yield* Effect.all(
            [
              verification.issue({ identifier, ttl: Duration.minutes(10) }),
              verification.issue({ identifier, ttl: Duration.minutes(10) }),
            ],
            { concurrency: "unbounded" },
          );

          const aResult = yield* verification.consume(identifier, a.value).pipe(Effect.exit);
          const bResult = yield* verification.consume(identifier, b.value).pipe(Effect.exit);
          const successes = [aResult, bResult].filter((exit) => exit._tag === "Success");
          assert.strictEqual(successes.length, 1);
        }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-063: reserve is true only for the first caller while unexpired", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const first = yield* verification.reserve({
          identifier: "promote:user-3",
          ttl: Duration.minutes(1),
        });
        const second = yield* verification.reserve({
          identifier: "promote:user-3",
          ttl: Duration.minutes(1),
        });
        assert.isTrue(first);
        assert.isFalse(second);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-063: a reservation may be re-claimed once it expires", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const first = yield* verification.reserve({
          identifier: "promote:user-4",
          ttl: Duration.millis(10),
        });
        yield* TestClock.adjust(Duration.millis(20));
        const second = yield* verification.reserve({
          identifier: "promote:user-4",
          ttl: Duration.millis(10),
        });
        assert.isTrue(first);
        assert.isTrue(second);
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("Verification (layerMemory)", MemoryLayer);
suite("Verification (layerSql)", SqlLayer);
