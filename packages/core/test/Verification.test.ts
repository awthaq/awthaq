// spec/behaviors/08-verification-tokens.md, BEH-EA-057 through BEH-EA-064.
//
// The same contract suite runs against both `Layer`s — `layerMemory` (a
// `Ref`) and `layerSql` (a real, in-memory SQLite database via
// `@effect/sql-sqlite-node`) — per
// spec/decisions/016-verification-sql-claiming.md (ADR-EA-016).
import { CoreMigrations, Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Users from "../src/Users.ts";
import * as Verification from "../src/Verification.ts";

const MemoryLayer = Verification.layerMemory.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
);

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

// BCR-003 (.issues/high): run against the real framework `Migrator` over
// `CoreMigrations.coreMigrations` — the same `packages/sql/test/
// Repositories.test.ts` precedent — rather than a hand-maintained fixture,
// so this suite also proves the real `verification_tokens` migration
// (including its own `userId` column) produces a working schema.
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
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
    // EOTS-004: the identifier embeds `<purpose>:<userId>`; it is a typed field, not message text.
    it.effect("EOTS-004: TokenConsumed's message never contains the identifier", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const failure = yield* verification
          .consume("reset-password:user-secret-id", Redacted.make("nope"))
          .pipe(Effect.flip);
        if (failure._tag !== "Verification/TokenConsumed") return assert.fail(failure._tag);
        assert.strictEqual(failure.identifier, "reset-password:user-secret-id");
        assert.notInclude(failure.message, "user-secret-id");
      }).pipe(Effect.provide(layer)),
    );

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
        assert.strictEqual(replay._tag, "Verification/TokenConsumed");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-059: an unknown identifier fails with the same TokenConsumed error", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const bogus = Redacted.make("does-not-exist");
        const failure = yield* verification.consume("verify-email:nobody", bogus).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "Verification/TokenConsumed");
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
        assert.strictEqual(failure._tag, "Verification/TokenConsumed");
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
          assert.strictEqual(failure._tag, "Verification/TokenConsumed");
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

    it.effect("ESS-010: an explicit null payload round-trips as undefined in both layers", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const identifier = "verify-email:user-13";
        const { value } = yield* verification.issue({
          identifier,
          ttl: Duration.minutes(10),
          payload: null,
        });
        const consumed = yield* verification.consume(identifier, value);
        assert.isUndefined(consumed.payload);
      }).pipe(Effect.provide(layer)),
    );

    // MLO-006: BEH-EA-062's "at most one concurrent caller succeeds", raced
    // for real (the sequential test above cannot catch a read-then-delete).
    it.effect("BEH-EA-062: two concurrent consumes of one token yield exactly one success", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const events = yield* AuthEvents.AuthEvents;
        const identifier = "verify-email:user-14";
        const { value } = yield* verification.issue({ identifier, ttl: Duration.minutes(10) });
        const replays = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter((event) => event._tag === "auth.token.replay"),
            Stream.take(1),
            Stream.runCollect,
          ),
          { startImmediately: true },
        );
        const outcomes = yield* Effect.all(
          [
            verification.consume(identifier, value).pipe(Effect.exit),
            verification.consume(identifier, value).pipe(Effect.exit),
          ],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(outcomes.filter((exit) => exit._tag === "Success").length, 1);
        assert.strictEqual(outcomes.filter((exit) => exit._tag === "Failure").length, 1);
        const published = yield* Fiber.join(replays);
        assert.strictEqual(published.length, 1);
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

    it.effect("BCR-003: a token issued with no userId carries None", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const identifier = "oauth-flow:no-user-yet";
        const { token } = yield* verification.issue({ identifier, ttl: Duration.minutes(10) });
        assert.isTrue(Option.isNone(token.userId));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BCR-003: a token issued with userId carries it through issue and consume", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const userId = Users.UserId("bcr-003-user-1");
        const identifier = `verify-email:${userId}`;
        const { token, value } = yield* verification.issue({
          identifier,
          ttl: Duration.minutes(10),
          userId,
        });
        assert.deepStrictEqual(token.userId, Option.some(userId));
        const consumed = yield* verification.consume(identifier, value);
        assert.deepStrictEqual(consumed.userId, Option.some(userId));
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "BCR-003: deleteAllByUser removes that user's live token, leaves another user's untouched",
      () =>
        Effect.gen(function* () {
          const verification = yield* Verification.Verification;
          const target = Users.UserId("bcr-003-user-2");
          const other = Users.UserId("bcr-003-user-3");

          const targetIdentifier = `verify-email:${target}`;
          const { value: targetValue } = yield* verification.issue({
            identifier: targetIdentifier,
            ttl: Duration.minutes(10),
            userId: target,
          });
          const otherIdentifier = `verify-email:${other}`;
          const { value: otherValue } = yield* verification.issue({
            identifier: otherIdentifier,
            ttl: Duration.minutes(10),
            userId: other,
          });

          yield* verification.deleteAllByUser(target);

          // The real, correct value now fails — proof the row is gone, not
          // merely that a wrong guess was rejected (both would otherwise
          // collapse into the same uniform `TokenConsumed`, BEH-EA-059).
          const targetOutcome = yield* verification
            .consume(targetIdentifier, targetValue)
            .pipe(Effect.flip);
          assert.strictEqual(targetOutcome._tag, "Verification/TokenConsumed");

          // The unrelated user's own live token is untouched — its real
          // value still consumes successfully.
          const otherConsumed = yield* verification.consume(otherIdentifier, otherValue);
          assert.strictEqual(otherConsumed.identifier, otherIdentifier);
        }).pipe(Effect.provide(layer)),
    );

    it.effect("BCR-003: deleteAllByUser also sweeps that user's already-consumed history", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const target = Users.UserId("bcr-003-user-4");
        const identifier = `reset-password:${target}`;
        const { value } = yield* verification.issue({
          identifier,
          ttl: Duration.minutes(10),
          userId: target,
        });
        yield* verification.consume(identifier, value);
        // Consumed history sweeps without error — nothing to assert on the
        // read side (a consumed row is already unreachable via `consume`),
        // this proves `deleteAllByUser` doesn't die on a userId with only
        // historical rows.
        yield* verification.deleteAllByUser(target);
      }).pipe(Effect.provide(layer)),
    );

    // BCR-005: a caller-formatted (numeric) value, minted inside Verification.
    it.effect("BCR-005: a numeric token is exactly N digits and consumes once", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const { value } = yield* verification.issue({
          identifier: "email-otp:digits@example.com",
          ttl: Duration.minutes(5),
          format: { _tag: "Numeric", digits: 6 },
          maxAttempts: 3,
        });
        assert.match(Redacted.value(value), /^[0-9]{6}$/);
        yield* verification.consume("email-otp:digits@example.com", value);
        const replay = yield* verification
          .consume("email-otp:digits@example.com", value)
          .pipe(Effect.flip);
        assert.strictEqual(replay._tag, "Verification/TokenConsumed");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BCR-005: numeric digits are drawn uniformly (no modulo bias)", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const counts = new Array<number>(10).fill(0);
        for (let i = 0; i < 1500; i += 1) {
          const { value } = yield* verification.issue({
            identifier: `email-otp:uniform-${i}`,
            ttl: Duration.minutes(5),
            format: { _tag: "Numeric", digits: 6 },
            maxAttempts: 3,
          });
          for (const digit of Redacted.value(value)) counts[Number(digit)] = (counts[Number(digit)] ?? 0) + 1;
        }
        // 9000 digits, expectation 900 each: a chi-square statistic over 10 buckets (df 9)
        // stays far below 27.88 (p = 0.001) for an unbiased source.
        const expected = 900;
        const chi = counts.reduce((sum, observed) => sum + (observed - expected) ** 2 / expected, 0);
        assert.isBelow(chi, 27.88);
      }).pipe(Effect.provide(layer)),
    );

    // SOS-004: a per-token attempt budget — a 6-digit code must not be guessable within its TTL.
    it.effect("SOS-004: a token with maxAttempts 3 is burned by 3 wrong guesses, even for the right value next", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const identifier = "email-otp:budget@example.com";
        const { value } = yield* verification.issue({
          identifier,
          ttl: Duration.minutes(5),
          format: { _tag: "Numeric", digits: 6 },
          maxAttempts: 3,
        });
        const wrong = Redacted.make(Redacted.value(value) === "000000" ? "111111" : "000000");
        for (let i = 0; i < 3; i += 1) {
          const failure = yield* verification.consume(identifier, wrong).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "Verification/TokenConsumed");
        }
        const late = yield* verification.consume(identifier, value).pipe(Effect.flip);
        assert.strictEqual(late._tag, "Verification/TokenConsumed");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("SOS-004: fewer wrong guesses than the budget leave the token usable", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const identifier = "email-otp:budget-ok@example.com";
        const { value } = yield* verification.issue({
          identifier,
          ttl: Duration.minutes(5),
          format: { _tag: "Numeric", digits: 6 },
          maxAttempts: 3,
        });
        const wrong = Redacted.make(Redacted.value(value) === "000000" ? "111111" : "000000");
        yield* verification.consume(identifier, wrong).pipe(Effect.flip);
        yield* verification.consume(identifier, wrong).pipe(Effect.flip);
        const consumed = yield* verification.consume(identifier, value);
        assert.strictEqual(consumed.identifier, identifier);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("SOS-004: a 256-bit token without maxAttempts is never burned by wrong guesses", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const identifier = "verify-email:no-budget";
        const { value } = yield* verification.issue({ identifier, ttl: Duration.minutes(5) });
        for (let i = 0; i < 10; i += 1) {
          yield* verification.consume(identifier, Redacted.make("wrong")).pipe(Effect.flip);
        }
        const consumed = yield* verification.consume(identifier, value);
        assert.strictEqual(consumed.identifier, identifier);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("SOS-004: a wrong guess against an unknown identifier changes nothing", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const failure = yield* verification
          .consume("email-otp:nobody@example.com", Redacted.make("123456"))
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "Verification/TokenConsumed");
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("Verification (layerMemory)", MemoryLayer);
suite("Verification (layerSql)", SqlLayer);

describe("Verification (layerMemory) pruning (TMS-004)", () => {
  it.effect("reserve stays correct once expired reservations are pruned", () =>
    Effect.gen(function* () {
      const verification = yield* Verification.Verification;
      for (let i = 0; i < 10_050; i++) {
        yield* verification.reserve({ identifier: `spray:${i}`, ttl: Duration.seconds(1) });
      }
      yield* verification.reserve({ identifier: "live", ttl: Duration.minutes(10) });
      yield* TestClock.adjust(Duration.seconds(2));
      // The prune runs on this call: expired spray reservations go, the live one stays.
      assert.isTrue(
        yield* verification.reserve({ identifier: "spray:0", ttl: Duration.seconds(1) }),
      );
      assert.isFalse(yield* verification.reserve({ identifier: "live", ttl: Duration.minutes(10) }));
    }).pipe(Effect.provide(MemoryLayer)),
  );
});

// MA-004: an infrastructure failure is the typed `StoreUnavailable`, never a defect.
describe("Verification infrastructure failures (MA-004)", () => {
  const DownRepository = Layer.effect(
    Repositories.VerificationReservationsRepository,
    Effect.gen(function* () {
      const real = yield* Repositories.VerificationReservationsRepository;
      return {
        ...real,
        claim: () =>
          Effect.fail(
            new SqlError({ reason: new UnknownError({ cause: new Error("connection reset") }) }),
          ),
      };
    }),
  ).pipe(Layer.provide(Repositories.VerificationReservationsRepositoryLive));

  const DownLayer = Verification.layerSql.pipe(
    Layer.provide(Repositories.VerificationRepositoryLive),
    Layer.provide(DownRepository),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(Migrated),
  );

  it.effect("layerSql: a SqlError from the repository surfaces as StoreUnavailable", () =>
    Effect.gen(function* () {
      const verification = yield* Verification.Verification;
      const failure = yield* verification
        .reserve({ identifier: "x", ttl: Duration.minutes(1) })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      assert.strictEqual(failure.operation, "Verification.reserve");
    }).pipe(Effect.provide(DownLayer)),
  );

  const BrokenCryptoLayer = Verification.layerMemory.pipe(
    Layer.provide(
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: () =>
            Effect.fail(
              PlatformError.systemError({
                module: "Crypto",
                method: "digest",
                _tag: "Unknown",
                description: "provider down",
              }),
            ),
        }),
      ),
    ),
    Layer.provide(AuthEvents.layer),
    Layer.provide(AuditLog.layerMemory),
  );

  it.effect("layerMemory: a crypto PlatformError surfaces as StoreUnavailable", () =>
    Effect.gen(function* () {
      const verification = yield* Verification.Verification;
      const issueFailure = yield* verification
        .issue({ identifier: "x", ttl: Duration.minutes(1) })
        .pipe(Effect.flip);
      assert.strictEqual(issueFailure._tag, "StoreUnavailable");
      const consumeFailure = yield* verification
        .consume("x", Redacted.make("nope"))
        .pipe(Effect.flip);
      assert.strictEqual(consumeFailure._tag, "StoreUnavailable");
    }).pipe(Effect.provide(BrokenCryptoLayer)),
  );
});
