// spec/behaviors/08-verification-tokens.md, BEH-EA-057 through BEH-EA-064.
//
// Plan 02 (ADR-EA-041): `Verification` is one implementation over `VerificationStore`, so its domain
// suite runs once, over the `Ref` adapter. What a store must do on every backend (one atomic claim,
// the live-row replacement, the reservation boundary, the budget spend) is
// `StoreContract.verification`; the SQL adapter's own failure mapping is
// `packages/sql/test/VerificationStoreSql.test.ts`; the blocks below that name a real transaction
// are SQL compositions: the protocol of `redeem` (ADR-EA-039) over `VerificationStoreSql`, per
// spec/decisions/016-verification-sql-claiming.md (ADR-EA-016).
import * as TestEncryption from "../../test/src/TestEncryption.ts";
import { SqlTransaction, VerificationStore } from "@awthaq/ports";
import { CoreMigrations, Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Persistence from "../src/Persistence.ts";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";
import { StoreUnavailable } from "../src/Errors.ts";
import * as Users from "../src/Users.ts";
import * as Verification from "../src/Verification.ts";

/** Every SQL store over the ambient `SqlClient` (plan 02): provide it where the composition is built. */
const SqlStores = Persistence.sql().pipe(Layer.provide(TestEncryption.layer));

const MemoryLayer = Verification.layer
  .pipe(Layer.provide(Persistence.memory))
  .pipe(
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
  );

// PV-010: `:memory:` SQLite by default, a real Postgres schema under `pnpm run test:pg`.
const SqlLive = TestSql.layer("core_Verification");

// BCR-003 (.issues/high): run against the real framework `Migrator` over
// `CoreMigrations.coreMigrations` — the same `packages/sql/test/
// Repositories.test.ts` precedent — rather than a hand-maintained fixture,
// so this suite also proves the real `verification_tokens` migration
// (including its own `userId` column) produces a working schema.
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

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

    // BEH-EA-063: a reservation is expired iff `now >= expiresAt`, in both layers.
    it.effect("BEH-EA-063: a reservation is expired at exactly its expiresAt", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const ttl = Duration.seconds(30);
        assert.isTrue(yield* verification.reserve({ identifier: "promote:edge", ttl }));
        yield* TestClock.adjust(Duration.millis(Duration.toMillis(ttl) - 1));
        assert.isFalse(yield* verification.reserve({ identifier: "promote:edge", ttl }));
        yield* TestClock.adjust(Duration.millis(1));
        assert.isTrue(yield* verification.reserve({ identifier: "promote:edge", ttl }));
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
        const counts = Array.from({ length: 10 }, () => 0);
        for (let i = 0; i < 1500; i += 1) {
          const { value } = yield* verification.issue({
            identifier: `email-otp:uniform-${i}`,
            ttl: Duration.minutes(5),
            format: { _tag: "Numeric", digits: 6 },
            maxAttempts: 3,
          });
          for (const digit of Redacted.value(value))
            counts[Number(digit)] = (counts[Number(digit)] ?? 0) + 1;
        }
        // 9000 digits, expectation 900 each: a chi-square statistic over 10 buckets (df 9).
        // The bound is p = 1.3e-9 (60), not p = 0.001: an unseeded draw that failed one run in a
        // thousand made CI flaky, and a digit that is skewed enough to matter is still far above it.
        const expected = 900;
        const chi = counts.reduce(
          (sum, observed) => sum + (observed - expected) ** 2 / expected,
          0,
        );
        assert.isBelow(chi, 60);
      }).pipe(Effect.provide(layer)),
    );

    // SOS-004: a per-token attempt budget — a 6-digit code must not be guessable within its TTL.
    it.effect(
      "SOS-004: a token with maxAttempts 3 is burned by 3 wrong guesses, even for the right value next",
      () =>
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

    // ---- ADR-EA-039: redeem, the same contract over both adapters ----
    const issueOne = (identifier: string, extra?: { readonly maxAttempts: number }) =>
      Effect.flatMap(Verification.Verification, (verification) =>
        verification.issue(
          extra === undefined
            ? { identifier, ttl: Duration.minutes(10), payload: { carried: identifier } }
            : {
                identifier,
                ttl: Duration.minutes(5),
                format: { _tag: "Numeric", digits: 6 },
                maxAttempts: extra.maxAttempts,
              },
        ),
      );

    const collectReplays = (take: number) =>
      Effect.flatMap(AuthEvents.AuthEvents, (events) =>
        Effect.forkChild(
          events.stream.pipe(
            Stream.filter((event) => event._tag === "auth.token.replay"),
            Stream.take(take),
            Stream.runCollect,
          ),
          { startImmediately: true },
        ),
      );

    it.effect(
      "ADR-EA-039: redeem runs use with the claimed token and spends it; a second redeem misses with TokenConsumed",
      () =>
        Effect.gen(function* () {
          const verification = yield* Verification.Verification;
          const identifier = "reset-password:redeem-1";
          const { value } = yield* issueOne(identifier);
          const seen = yield* verification.redeem({
            identifier,
            value,
            use: (token) => Effect.succeed(token.payload),
          });
          assert.deepStrictEqual(seen, { carried: identifier });
          const replay = yield* verification
            .redeem({ identifier, value, use: () => Effect.void })
            .pipe(Effect.flip);
          assert.strictEqual(replay._tag, "Verification/TokenConsumed");
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "ADR-EA-039: a use that fails (rollback) gives the token back: the same value redeems on the next call",
      () =>
        Effect.gen(function* () {
          const verification = yield* Verification.Verification;
          const identifier = "reset-password:redeem-2";
          const { value } = yield* issueOne(identifier);
          const refused = yield* verification
            .redeem({ identifier, value, use: () => Effect.fail("refused" as const) })
            .pipe(Effect.flip);
          assert.strictEqual(refused, "refused");
          const again = yield* verification.redeem({
            identifier,
            value,
            use: (token) => Effect.succeed(token.identifier),
          });
          assert.strictEqual(again, identifier);
        }).pipe(Effect.provide(layer)),
    );

    it.effect("ADR-EA-039: a use that dies gives the token back", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const identifier = "reset-password:redeem-3";
        const { value } = yield* issueOne(identifier);
        const exit = yield* verification
          .redeem({ identifier, value, use: () => Effect.die("boom") })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        const again = yield* verification.redeem({
          identifier,
          value,
          use: (token) => Effect.succeed(token.identifier),
        });
        assert.strictEqual(again, identifier);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("ADR-EA-039: an interrupted use gives the token back", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const identifier = "reset-password:redeem-4";
        const { value } = yield* issueOne(identifier);
        const entered = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          verification.redeem({
            identifier,
            value,
            use: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        const again = yield* verification.redeem({
          identifier,
          value,
          use: (token) => Effect.succeed(token.identifier),
        });
        assert.strictEqual(again, identifier);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "ADR-EA-039: a refusal settled as commit spends the token and still fails with use's own error",
      () =>
        Effect.gen(function* () {
          const verification = yield* Verification.Verification;
          const identifier = "magic-link:redeem-5";
          const { value } = yield* issueOne(identifier);
          const refused = yield* verification
            .redeem({
              identifier,
              value,
              use: () => Effect.fail("vetoed" as const),
              onFailure: () => "commit",
            })
            .pipe(Effect.flip);
          assert.strictEqual(refused, "vetoed");
          const replay = yield* verification
            .redeem({ identifier, value, use: () => Effect.void })
            .pipe(Effect.flip);
          assert.strictEqual(replay._tag, "Verification/TokenConsumed");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("ADR-EA-039: commitUnlessUnavailable gives an outage back and spends a refusal", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const outage = { _tag: "StoreUnavailable" } as const;
        assert.strictEqual(Verification.commitUnlessUnavailable(outage), "rollback");
        assert.strictEqual(Verification.commitUnlessUnavailable({ _tag: "Vetoed" }), "commit");
        const identifier = "magic-link:redeem-5b";
        const { value } = yield* issueOne(identifier);
        yield* verification
          .redeem({
            identifier,
            value,
            use: () => Effect.fail(outage),
            onFailure: Verification.commitUnlessUnavailable,
          })
          .pipe(Effect.flip);
        const again = yield* verification.redeem({
          identifier,
          value,
          use: (token) => Effect.succeed(token.identifier),
        });
        assert.strictEqual(again, identifier);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "ADR-EA-039/BEH-EA-059: a miss never runs use, fails TokenConsumed and publishes exactly one auth.token.replay",
      () =>
        Effect.gen(function* () {
          const verification = yield* Verification.Verification;
          const replays = yield* collectReplays(1);
          let ran = false;
          const failure = yield* verification
            .redeem({
              identifier: "verify-email:redeem-6",
              value: Redacted.make("nope"),
              use: () =>
                Effect.sync(() => {
                  ran = true;
                }),
            })
            .pipe(Effect.flip);
          assert.strictEqual(failure._tag, "Verification/TokenConsumed");
          assert.isFalse(ran);
          const published = yield* Fiber.join(replays);
          assert.strictEqual(published.length, 1);
        }).pipe(Effect.provide(layer)),
    );

    it.effect("ADR-EA-039/BEH-EA-059: a rolled-back use publishes no auth.token.replay", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const events = yield* AuthEvents.AuthEvents;
        const identifier = "reset-password:redeem-7";
        const { value } = yield* issueOne(identifier);
        const replays = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter((event) => event._tag === "auth.token.replay"),
            Stream.take(1),
            Stream.runCollect,
          ),
          { startImmediately: true },
        );
        yield* verification
          .redeem({ identifier, value, use: () => Effect.fail("refused" as const) })
          .pipe(Effect.flip);
        yield* verification.redeem({ identifier, value, use: () => Effect.void });
        // The one replay is the one we cause now, so the rollback published none before it.
        yield* verification.redeem({ identifier, value, use: () => Effect.void }).pipe(Effect.flip);
        const published = yield* Fiber.join(replays);
        assert.strictEqual(published.length, 1);
        const [event] = published;
        assert.strictEqual(event?._tag, "auth.token.replay");
        assert.strictEqual(event?._tag === "auth.token.replay" ? event.identifier : "", identifier);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "SOS-004: a wrong value through redeem spends one attempt, and maxAttempts misses burn the token",
      () =>
        Effect.gen(function* () {
          const verification = yield* Verification.Verification;
          const identifier = "email-otp:redeem-8@example.com";
          const { value } = yield* issueOne(identifier, { maxAttempts: 3 });
          const wrong = Redacted.make(Redacted.value(value) === "000000" ? "111111" : "000000");
          for (let i = 0; i < 3; i += 1) {
            const failure = yield* verification
              .redeem({ identifier, value: wrong, use: () => Effect.void })
              .pipe(Effect.flip);
            assert.strictEqual(failure._tag, "Verification/TokenConsumed");
          }
          const late = yield* verification
            .redeem({ identifier, value, use: () => Effect.void })
            .pipe(Effect.flip);
          assert.strictEqual(late._tag, "Verification/TokenConsumed");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("SOS-004: a rolled-back use leaves a budgeted token's spent attempts unchanged", () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const identifier = "email-otp:redeem-9@example.com";
        const { value } = yield* issueOne(identifier, { maxAttempts: 3 });
        const wrong = Redacted.make(Redacted.value(value) === "000000" ? "111111" : "000000");
        yield* verification
          .redeem({ identifier, value: wrong, use: () => Effect.void })
          .pipe(Effect.flip);
        yield* verification
          .redeem({ identifier, value, use: () => Effect.fail("refused" as const) })
          .pipe(Effect.flip);
        // One miss spent, the rollback spent none: two more misses are still survivable, a third burns.
        yield* verification
          .redeem({ identifier, value: wrong, use: () => Effect.void })
          .pipe(Effect.flip);
        const survivor = yield* verification.redeem({
          identifier,
          value,
          use: (token) => Effect.succeed(token.identifier),
        });
        assert.strictEqual(survivor, identifier);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "BEH-EA-062: two concurrent redeems of one token run use to success at most once",
      () =>
        Effect.gen(function* () {
          const verification = yield* Verification.Verification;
          const identifier = "reset-password:redeem-10";
          const { value } = yield* issueOne(identifier);
          const outcomes = yield* Effect.all(
            [
              verification.redeem({ identifier, value, use: () => Effect.void }).pipe(Effect.exit),
              verification.redeem({ identifier, value, use: () => Effect.void }).pipe(Effect.exit),
            ],
            { concurrency: "unbounded" },
          );
          assert.strictEqual(outcomes.filter((exit) => Exit.isSuccess(exit)).length, 1);
          assert.strictEqual(outcomes.filter((exit) => Exit.isFailure(exit)).length, 1);
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "ADR-EA-039: consume and redeem share one claim: a token spent by one misses through the other",
      () =>
        Effect.gen(function* () {
          const verification = yield* Verification.Verification;
          const first = yield* issueOne("reset-password:redeem-11a");
          yield* verification.consume("reset-password:redeem-11a", first.value);
          const viaRedeem = yield* verification
            .redeem({
              identifier: "reset-password:redeem-11a",
              value: first.value,
              use: () => Effect.void,
            })
            .pipe(Effect.flip);
          assert.strictEqual(viaRedeem._tag, "Verification/TokenConsumed");
          const second = yield* issueOne("reset-password:redeem-11b");
          yield* verification.redeem({
            identifier: "reset-password:redeem-11b",
            value: second.value,
            use: () => Effect.void,
          });
          const viaConsume = yield* verification
            .consume("reset-password:redeem-11b", second.value)
            .pipe(Effect.flip);
          assert.strictEqual(viaConsume._tag, "Verification/TokenConsumed");
        }).pipe(Effect.provide(layer)),
    );
  });
};

suite("Verification", MemoryLayer);

// MA-004: an infrastructure failure is the typed `StoreUnavailable`, never a defect.
describe("Verification infrastructure failures (MA-004)", () => {
  // The store double names its own primitive, as an adapter does; the service relabels it to the
  // operation the caller ran, so the wire label does not change.
  const down = (primitive: string) => Effect.fail(new StoreUnavailable({ operation: primitive }));

  const DownStore = Layer.mock(VerificationStore.VerificationStore, {
    upsertLive: () => down("VerificationStore.upsertLive"),
    present: () => down("VerificationStore.present"),
    settle: () => Effect.void,
    transaction: () => down("VerificationStore.transaction"),
    reserve: () => down("VerificationStore.reserve"),
    deleteByUser: () => down("VerificationStore.deleteByUser"),
    purgeExpired: () => down("VerificationStore.purgeExpired"),
  });

  const DownLayer = Verification.layer.pipe(
    Layer.provide(DownStore),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
  );

  it.effect("a store outage surfaces as StoreUnavailable named for the service operation", () =>
    Effect.gen(function* () {
      const verification = yield* Verification.Verification;
      const operationOf = <A>(effect: Effect.Effect<A, unknown>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((failure) =>
            Predicate.isTagged(failure, "StoreUnavailable") && "operation" in failure
              ? failure.operation
              : String(failure),
          ),
        );
      assert.strictEqual(
        yield* operationOf(verification.reserve({ identifier: "x", ttl: Duration.minutes(1) })),
        "Verification.reserve",
      );
      assert.strictEqual(
        yield* operationOf(verification.issue({ identifier: "x", ttl: Duration.minutes(1) })),
        "Verification.issue",
      );
      assert.strictEqual(
        yield* operationOf(verification.consume("x", Redacted.make("y"))),
        "Verification.consume",
      );
      assert.strictEqual(
        yield* operationOf(
          verification.redeem({
            identifier: "x",
            value: Redacted.make("y"),
            use: () => Effect.void,
          }),
        ),
        "Verification.redeem",
      );
      assert.strictEqual(
        yield* operationOf(verification.deleteAllByUser(Users.UserId("u"))),
        "Verification.deleteAllByUser",
      );
      assert.strictEqual(
        yield* operationOf(verification.purgeExpired(DateTime.makeUnsafe(0))),
        "Verification.purgeExpired",
      );
    }).pipe(Effect.provide(DownLayer)),
  );

  const BrokenCryptoLayer = Verification.layer.pipe(Layer.provide(Persistence.memory)).pipe(
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
    Layer.provide(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
  );

  it.effect("Persistence.memory: a crypto PlatformError surfaces as StoreUnavailable", () =>
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

// ADR-EA-037 (was PV-220): a consume that fails inside the caller's transaction must not lose what a
// miss records. The replay event is an attempt event and the spent attempt runs in the unit of work's
// `afterUnit` lane, so both survive the rollback without the caller doing anything.
describe("Verification miss inside a rolled-back transaction (ADR-EA-037)", () => {
  const SqlAuditLayer = Verification.layer
    .pipe(Layer.provide(SqlStores))
    .pipe(
      Layer.provide(Repositories.VerificationRepositoryLive),
      Layer.provide(Repositories.VerificationReservationsRepositoryLive),
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(AuthEvents.layer),
      Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(SqlStores))),
      Layer.provideMerge(SqlLive),
      Layer.provideMerge(Migrated),
    );

  const replayRows = Effect.flatMap(AuditLog.AuditLog, (log) =>
    log.list({ eventTag: "auth.token.replay" }),
  );

  it.effect("Persistence.sql(): a miss inside a failing transaction is still audited", () =>
    Effect.gen(function* () {
      const verification = yield* Verification.Verification;
      const sql = yield* SqlClient.SqlClient;
      const identifier = "verify-email:pv220";
      const failed = yield* SqlTransaction.transactional(sql)(
        verification.consume(identifier, Redacted.make("nope")),
      ).pipe(Effect.flip);
      assert.strictEqual(failed._tag, "Verification/TokenConsumed");
      const rows = yield* replayRows;
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual(rows[0]?.payload, { _tag: "auth.token.replay", identifier });
    }).pipe(Effect.provide(SqlAuditLayer)),
  );

  it.effect(
    "Persistence.sql(): attempts spent by misses inside a rolled-back transaction still burn a budgeted token",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const sql = yield* SqlClient.SqlClient;
        const identifier = "email-otp:pv220@example.com";
        const { value } = yield* verification.issue({
          identifier,
          ttl: Duration.minutes(5),
          format: { _tag: "Numeric", digits: 6 },
          maxAttempts: 2,
        });
        const wrong = Redacted.make(Redacted.value(value) === "000000" ? "111111" : "000000");
        for (let i = 0; i < 2; i += 1) {
          yield* SqlTransaction.transactional(sql)(verification.consume(identifier, wrong)).pipe(
            Effect.flip,
          );
        }
        const late = yield* verification.consume(identifier, value).pipe(Effect.flip);
        assert.strictEqual(late._tag, "Verification/TokenConsumed");
      }).pipe(Effect.provide(SqlAuditLayer)),
  );

  it.effect("Persistence.memory: a miss publishes exactly one replay row", () =>
    Effect.gen(function* () {
      const verification = yield* Verification.Verification;
      const identifier = "verify-email:pv220-memory";
      yield* verification.consume(identifier, Redacted.make("nope")).pipe(Effect.flip);
      assert.strictEqual((yield* replayRows).length, 1);
    }).pipe(Effect.provide(MemoryLayer)),
  );
});

// ADR-EA-039: what only a real transaction can prove, on SQLite and (under `pnpm test:pg`) Postgres.
describe("Verification.redeem over a real transaction", () => {
  const SqlAuditLayer = Verification.layer
    .pipe(Layer.provide(SqlStores))
    .pipe(
      Layer.provide(Repositories.VerificationRepositoryLive),
      Layer.provide(Repositories.VerificationReservationsRepositoryLive),
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(AuthEvents.layer),
      Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(SqlStores))),
      Layer.provideMerge(SqlLive),
      Layer.provideMerge(Migrated),
    );

  const replayRows = Effect.flatMap(AuditLog.AuditLog, (log) =>
    log.list({ eventTag: "auth.token.replay" }),
  );

  const issueOne = (identifier: string, maxAttempts?: number) =>
    Effect.flatMap(Verification.Verification, (verification) =>
      verification.issue(
        maxAttempts === undefined
          ? { identifier, ttl: Duration.minutes(10) }
          : {
              identifier,
              ttl: Duration.minutes(5),
              format: { _tag: "Numeric", digits: 6 },
              maxAttempts,
            },
      ),
    );

  it.effect("Persistence.sql(): use's own writes and the claim commit or roll back together", () =>
    Effect.gen(function* () {
      const verification = yield* Verification.Verification;
      const ttl = Duration.minutes(10);
      const identifier = "reset-password:tx-1";
      const { value } = yield* issueOne(identifier);
      // The witness is a write made inside `use`: a reservation, which commits or rolls back with it.
      const rolledBack = yield* verification
        .redeem({
          identifier,
          value,
          use: () =>
            verification
              .reserve({ identifier: "witness:rollback", ttl })
              .pipe(Effect.andThen(Effect.fail("refused" as const))),
        })
        .pipe(Effect.flip);
      assert.strictEqual(rolledBack, "refused");
      assert.isTrue(yield* verification.reserve({ identifier: "witness:rollback", ttl }));
      yield* verification.redeem({
        identifier,
        value,
        use: () => verification.reserve({ identifier: "witness:commit", ttl }),
      });
      assert.isFalse(yield* verification.reserve({ identifier: "witness:commit", ttl }));
      const replay = yield* verification
        .redeem({ identifier, value, use: () => Effect.void })
        .pipe(Effect.flip);
      assert.strictEqual(replay._tag, "Verification/TokenConsumed");
    }).pipe(Effect.provide(SqlAuditLayer)),
  );

  it.effect(
    "Persistence.sql() + AuditLog: a miss through redeem leaves exactly one durable auth.token.replay row",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const identifier = "verify-email:tx-2";
        const failed = yield* verification
          .redeem({ identifier, value: Redacted.make("nope"), use: () => Effect.void })
          .pipe(Effect.flip);
        assert.strictEqual(failed._tag, "Verification/TokenConsumed");
        const rows = yield* replayRows;
        assert.strictEqual(rows.length, 1);
        assert.deepStrictEqual(rows[0]?.payload, { _tag: "auth.token.replay", identifier });
      }).pipe(Effect.provide(SqlAuditLayer)),
  );

  it.effect(
    "Persistence.sql(): misses through redeem burn a budgeted token (the spent attempt commits)",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const identifier = "email-otp:tx-3@example.com";
        const { value } = yield* issueOne(identifier, 2);
        const wrong = Redacted.make(Redacted.value(value) === "000000" ? "111111" : "000000");
        for (let i = 0; i < 2; i += 1) {
          yield* verification
            .redeem({ identifier, value: wrong, use: () => Effect.void })
            .pipe(Effect.flip);
        }
        const late = yield* verification
          .redeem({ identifier, value, use: () => Effect.void })
          .pipe(Effect.flip);
        assert.strictEqual(late._tag, "Verification/TokenConsumed");
      }).pipe(Effect.provide(SqlAuditLayer)),
  );

  it.effect(
    "Persistence.sql(): a use that fails on a real SQL statement rolls back and the token redeems afterwards",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const sql = yield* SqlClient.SqlClient;
        const ttl = Duration.minutes(10);
        const identifier = "reset-password:tx-4";
        const { value } = yield* issueOne(identifier);
        yield* TestSql.injectFailure({
          name: "verification_redeem_fail_insert",
          table: "verification_reservations",
          event: "INSERT",
        });
        const failed = yield* verification
          .redeem({
            identifier,
            value,
            use: () => verification.reserve({ identifier: "witness:injected", ttl }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(failed._tag, "StoreUnavailable");
        yield* sql.onDialectOrElse({
          pg: () =>
            sql.unsafe("DROP TRIGGER verification_redeem_fail_insert ON verification_reservations"),
          orElse: () => sql.unsafe("DROP TRIGGER verification_redeem_fail_insert"),
        });
        const again = yield* verification.redeem({
          identifier,
          value,
          use: (token) => Effect.succeed(token.identifier),
        });
        assert.strictEqual(again, identifier);
      }).pipe(Effect.provide(SqlAuditLayer)),
  );

  it.effect(
    "Persistence.sql(): a redeem nested in an outer transaction is a savepoint: a rollback inside keeps the outer transaction usable, and a miss inside commits with it",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const sql = yield* SqlClient.SqlClient;
        const ttl = Duration.minutes(10);
        const identifier = "reset-password:tx-5";
        const { value } = yield* issueOne(identifier);
        yield* SqlTransaction.transactional(sql)(
          Effect.gen(function* () {
            yield* verification.reserve({ identifier: "witness:outer", ttl });
            const inner = yield* verification
              .redeem({
                identifier,
                value,
                use: () =>
                  verification
                    .reserve({ identifier: "witness:inner", ttl })
                    .pipe(Effect.andThen(Effect.fail("refused" as const))),
              })
              .pipe(Effect.flip);
            assert.strictEqual(inner, "refused");
            const miss = yield* verification
              .redeem({ identifier: "verify-email:tx-5", value, use: () => Effect.void })
              .pipe(Effect.flip);
            assert.strictEqual(miss._tag, "Verification/TokenConsumed");
          }),
        );
        // The outer transaction committed its own write; the savepoint's write went with the rollback.
        assert.isFalse(yield* verification.reserve({ identifier: "witness:outer", ttl }));
        assert.isTrue(yield* verification.reserve({ identifier: "witness:inner", ttl }));
        const again = yield* verification.redeem({
          identifier,
          value,
          use: (token) => Effect.succeed(token.identifier),
        });
        assert.strictEqual(again, identifier);
        assert.strictEqual((yield* replayRows).length, 1);
      }).pipe(Effect.provide(SqlAuditLayer)),
  );
});

// ADR-EA-039: the compensation that gives a memory token back, and the drift it documents (TRBS-005).
describe("Verification (Persistence.memory) redeem compensation", () => {
  const issueOne = (identifier: string, extra?: { readonly userId: Users.UserId }) =>
    Effect.flatMap(Verification.Verification, (verification) =>
      verification.issue({
        identifier,
        ttl: Duration.minutes(10),
        ...(extra === undefined ? {} : { userId: extra.userId }),
      }),
    );

  it.effect(
    "a fresh issue while use runs supersedes; a rollback does not resurrect the older token",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const identifier = "reset-password:mem-1";
        const older = yield* issueOne(identifier);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          verification
            .redeem({
              identifier,
              value: older.value,
              use: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Effect.fail("refused" as const)),
                ),
            })
            .pipe(Effect.flip),
        );
        yield* Deferred.await(entered);
        const newer = yield* issueOne(identifier);
        yield* Deferred.succeed(release, undefined);
        assert.strictEqual(yield* Fiber.join(fiber), "refused");
        const stale = yield* verification
          .redeem({ identifier, value: older.value, use: () => Effect.void })
          .pipe(Effect.flip);
        assert.strictEqual(stale._tag, "Verification/TokenConsumed");
        yield* verification.redeem({ identifier, value: newer.value, use: () => Effect.void });
      }).pipe(Effect.provide(MemoryLayer)),
  );

  it.effect("deleteAllByUser while use runs; a rollback does not resurrect the swept token", () =>
    Effect.gen(function* () {
      const verification = yield* Verification.Verification;
      const identifier = "reset-password:mem-2";
      const userId = Users.UserId("mem-2-user");
      const { value } = yield* issueOne(identifier, { userId });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        verification
          .redeem({
            identifier,
            value,
            use: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.fail("refused" as const)),
              ),
          })
          .pipe(Effect.flip),
      );
      yield* Deferred.await(entered);
      yield* verification.deleteAllByUser(userId);
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual(yield* Fiber.join(fiber), "refused");
      const gone = yield* verification
        .redeem({ identifier, value, use: () => Effect.void })
        .pipe(Effect.flip);
      assert.strictEqual(gone._tag, "Verification/TokenConsumed");
    }).pipe(Effect.provide(MemoryLayer)),
  );

  it.effect(
    "a concurrent redeem of a held token misses at once (documented drift from SQL, which waits)",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const identifier = "reset-password:mem-3";
        const { value } = yield* issueOne(identifier);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* Effect.forkChild(
          verification.redeem({
            identifier,
            value,
            use: () =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          }),
        );
        yield* Deferred.await(entered);
        const second = yield* verification
          .redeem({ identifier, value, use: () => Effect.void })
          .pipe(Effect.flip);
        assert.strictEqual(second._tag, "Verification/TokenConsumed");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
      }).pipe(Effect.provide(MemoryLayer)),
  );

  it.effect("purgeExpired never removes a held claim", () =>
    Effect.gen(function* () {
      const verification = yield* Verification.Verification;
      const identifier = "reset-password:mem-4";
      const { value } = yield* issueOne(identifier);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        verification
          .redeem({
            identifier,
            value,
            use: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.fail("refused" as const)),
              ),
          })
          .pipe(Effect.flip),
      );
      yield* Deferred.await(entered);
      // A cutoff past the token's expiry would purge it if it were still live; the hold is not.
      const cutoff = DateTime.addDuration(yield* DateTime.now, Duration.hours(1));
      yield* verification.purgeExpired(cutoff);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      const again = yield* verification.redeem({
        identifier,
        value,
        use: (token) => Effect.succeed(token.identifier),
      });
      assert.strictEqual(again, identifier);
    }).pipe(Effect.provide(MemoryLayer)),
  );
});
