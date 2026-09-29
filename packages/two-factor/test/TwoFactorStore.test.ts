// THS-001 step 3, BCR-002, THS-005 (BEH-EA-261/262): the two records services over both layers —
// `layerMemory` and `layerSql` on a real database (SQLite by default, Postgres under
// `AWTHAQ_POSTGRES_URL`/`pnpm run test:pg`) with the plugin's real migrations, never a hand-written
// `CREATE TABLE`.
import { DataExport, Erasure, Migrations, Users } from "@awthaq/core";
import { PasswordHasher } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestSql from "../../sql/test/support/TestSql.ts";
import * as TwoFactor from "../src/TwoFactor.ts";
import * as TwoFactorStore from "../src/TwoFactorStore.ts";

const SqlLive = TestSql.layer("two_factor_TwoFactorStore");

const Migrated = Layer.effectDiscard(Migrations.run(TwoFactor.TwoFactor.migrations)).pipe(
  Layer.provide(SqlLive),
);

const SqlStores = Layer.mergeAll(
  TwoFactorStore.layerSecretsSql,
  TwoFactorStore.layerRecoveryCodesSql,
).pipe(Layer.provide(NodeCrypto.layer), Layer.provideMerge(SqlLive), Layer.provideMerge(Migrated));

const MemoryStores = Layer.mergeAll(
  TwoFactorStore.layerSecretsMemory,
  TwoFactorStore.layerRecoveryCodesMemory,
).pipe(Layer.provide(NodeCrypto.layer));

const hash = (text: string) => PasswordHasher.PhcHash(`$argon2id$test$${text}`);
const userA = Users.UserId("user-a");
const userB = Users.UserId("user-b");

const suite = (
  name: string,
  layer: Layer.Layer<
    TwoFactorStore.TwoFactorSecrets | TwoFactorStore.TwoFactorRecoveryCodes,
    unknown,
    never
  >,
): void => {
  describe(name, () => {
    it.effect("a pending secret is replaced until it is confirmed, then it is final", () =>
      Effect.gen(function* () {
        const secrets = yield* TwoFactorStore.TwoFactorSecrets;
        assert.isTrue(yield* secrets.upsertPending(userA, "envelope-1"));
        assert.isTrue(yield* secrets.upsertPending(userA, "envelope-2"));
        const pending = yield* secrets.find(userA);
        assert.strictEqual(Option.getOrThrow(pending).envelope, "envelope-2");
        assert.isTrue(Option.isNone(Option.getOrThrow(pending).confirmedAt));

        // Confirmation records the step of the code that proved it, exactly once.
        assert.isTrue(yield* secrets.confirm(userA, BigInt(100)));
        assert.isFalse(yield* secrets.confirm(userA, BigInt(101)));
        const confirmed = Option.getOrThrow(yield* secrets.find(userA));
        assert.isTrue(Option.isSome(confirmed.confirmedAt));
        assert.deepStrictEqual(confirmed.lastUsedStep, Option.some(BigInt(100)));

        // A confirmed secret is never overwritten by a fresh `enable`.
        assert.isFalse(yield* secrets.upsertPending(userA, "envelope-3"));
        assert.strictEqual(Option.getOrThrow(yield* secrets.find(userA)).envelope, "envelope-2");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("THS-005: lastUsedStep only moves forward, and never on an unconfirmed secret", () =>
      Effect.gen(function* () {
        const secrets = yield* TwoFactorStore.TwoFactorSecrets;
        yield* secrets.upsertPending(userA, "e");
        // Not yet confirmed: no step can be spent.
        assert.isFalse(yield* secrets.advanceLastUsedStep(userA, BigInt(5)));
        yield* secrets.confirm(userA, BigInt(10));
        assert.isFalse(yield* secrets.advanceLastUsedStep(userA, BigInt(10)));
        assert.isFalse(yield* secrets.advanceLastUsedStep(userA, BigInt(9)));
        assert.isTrue(yield* secrets.advanceLastUsedStep(userA, BigInt(11)));
        assert.isFalse(yield* secrets.advanceLastUsedStep(userA, BigInt(11)));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("THS-005: of many concurrent verifications of one step, exactly one wins", () =>
      Effect.gen(function* () {
        const secrets = yield* TwoFactorStore.TwoFactorSecrets;
        yield* secrets.upsertPending(userA, "e");
        yield* secrets.confirm(userA, BigInt(1));
        const results = yield* Effect.all(
          Array.from({ length: 12 }, () => secrets.advanceLastUsedStep(userA, BigInt(2))),
          { concurrency: "unbounded" },
        );
        assert.strictEqual(results.filter(Boolean).length, 1);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "reencrypt swaps the envelope only while the row still holds the one that was read",
      () =>
        Effect.gen(function* () {
          const secrets = yield* TwoFactorStore.TwoFactorSecrets;
          yield* secrets.upsertPending(userA, "old");
          assert.isFalse(yield* secrets.reencrypt(userA, "not-the-current-one", "new"));
          assert.isTrue(yield* secrets.reencrypt(userA, "old", "new"));
          assert.strictEqual(Option.getOrThrow(yield* secrets.find(userA)).envelope, "new");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("delete reports whether a row existed and leaves other users alone", () =>
      Effect.gen(function* () {
        const secrets = yield* TwoFactorStore.TwoFactorSecrets;
        yield* secrets.upsertPending(userA, "a");
        yield* secrets.upsertPending(userB, "b");
        assert.isTrue(yield* secrets.delete(userA));
        assert.isFalse(yield* secrets.delete(userA));
        assert.isTrue(Option.isSome(yield* secrets.find(userB)));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BCR-002: replaceAll swaps the whole set; countUnused tracks each spend", () =>
      Effect.gen(function* () {
        const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
        yield* codes.replaceAll(userA, [hash("1"), hash("2"), hash("3")]);
        yield* codes.replaceAll(userB, [hash("b1")]);
        assert.strictEqual(yield* codes.countUnused(userA), 3);
        const [first] = yield* codes.listUnused(userA);
        if (first === undefined) return assert.fail("no codes");
        assert.isTrue(yield* codes.markUsed(userA, first.id));
        assert.isFalse(yield* codes.markUsed(userA, first.id));
        assert.strictEqual(yield* codes.countUnused(userA), 2);
        // Another user's id cannot be spent through this user.
        const [theirs] = yield* codes.listUnused(userB);
        assert.isFalse(yield* codes.markUsed(userA, theirs?.id ?? ""));

        yield* codes.replaceAll(userA, [hash("x"), hash("y")]);
        const fresh = yield* codes.listUnused(userA);
        assert.strictEqual(fresh.length, 2);
        assert.isFalse(fresh.some((row) => row.id === first.id));
        assert.strictEqual(yield* codes.countUnused(userB), 1);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("a recovery code is spent exactly once under concurrent presentation", () =>
      Effect.gen(function* () {
        const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
        yield* codes.replaceAll(userA, [hash("only")]);
        const [row] = yield* codes.listUnused(userA);
        const results = yield* Effect.all(
          Array.from({ length: 10 }, () => codes.markUsed(userA, row?.id ?? "")),
          { concurrency: "unbounded" },
        );
        assert.strictEqual(results.filter(Boolean).length, 1);
        assert.strictEqual(yield* codes.countUnused(userA), 0);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("deleteAllByUser removes the secret's siblings for that user only", () =>
      Effect.gen(function* () {
        const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
        yield* codes.replaceAll(userA, [hash("1")]);
        yield* codes.replaceAll(userB, [hash("2")]);
        yield* codes.deleteAllByUser(userA);
        assert.strictEqual(yield* codes.countUnused(userA), 0);
        assert.strictEqual(yield* codes.countUnused(userB), 1);
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("TwoFactorStore (layerMemory)", MemoryStores);
suite("TwoFactorStore (layerSql)", SqlStores);

describe("TwoFactorStore.layerRecoveryCodesSql atomicity (BCR-002)", () => {
  it.effect("a failure while inserting the new set leaves the old set intact", () =>
    Effect.gen(function* () {
      const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
      yield* codes.replaceAll(userA, [hash("old-1"), hash("old-2")]);
      const before = (yield* codes.listUnused(userA)).map((row) => row.id).sort();

      // The delete succeeds, then the first insert fails: without the transaction the user would have no codes at all.
      yield* TestSql.injectFailure({
        name: "two_factor_fail_insert",
        table: "two_factor_recovery_code",
        event: "INSERT",
      });
      const failure = yield* codes.replaceAll(userA, [hash("new-1")]).pipe(Effect.exit);
      assert.isTrue(failure._tag === "Failure");

      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql.unsafe("DROP TRIGGER two_factor_fail_insert ON two_factor_recovery_code"),
        orElse: () => sql.unsafe("DROP TRIGGER two_factor_fail_insert"),
      });
      assert.deepStrictEqual((yield* codes.listUnused(userA)).map((row) => row.id).sort(), before);
    }).pipe(Effect.provide(SqlStores)),
  );
});

describe("TwoFactor erasure and export contributions (CSG-001/CSG-005)", () => {
  const RegistryLayer = SqlStores.pipe(
    Layer.provideMerge(Erasure.registryLayer),
    Layer.provideMerge(DataExport.registryLayer),
  );

  it.effect("erasure removes the secret and every recovery code of that user only", () =>
    Effect.gen(function* () {
      const secrets = yield* TwoFactorStore.TwoFactorSecrets;
      const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
      const registry = yield* Erasure.ErasureRegistry;
      yield* secrets.upsertPending(userA, "a");
      yield* secrets.upsertPending(userB, "b");
      yield* codes.replaceAll(userA, [hash("1")]);
      yield* codes.replaceAll(userB, [hash("2")]);

      yield* Layer.build(TwoFactor.twoFactorErasure);
      const contributions = yield* registry.contributions;
      assert.deepStrictEqual(
        contributions.map((c) => c.id),
        ["two_factor"],
      );
      for (const c of contributions) yield* c.erase({ userId: userA });

      assert.isTrue(Option.isNone(yield* secrets.find(userA)));
      assert.strictEqual(yield* codes.countUnused(userA), 0);
      assert.isTrue(Option.isSome(yield* secrets.find(userB)));
      assert.strictEqual(yield* codes.countUnused(userB), 1);
    }).pipe(Effect.scoped, Effect.provide(RegistryLayer)),
  );

  it.effect(
    "the export says whether a factor exists and how many codes remain — never a secret or a hash",
    () =>
      Effect.gen(function* () {
        const secrets = yield* TwoFactorStore.TwoFactorSecrets;
        const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
        const registry = yield* DataExport.DataExportRegistry;
        yield* secrets.upsertPending(userA, "SUPER-SECRET-ENVELOPE");
        yield* secrets.confirm(userA, BigInt(1));
        yield* codes.replaceAll(userA, [hash("SECRET-HASH-1"), hash("SECRET-HASH-2")]);

        yield* Layer.build(TwoFactor.twoFactorExport);
        const [contribution] = yield* registry.contributions;
        const section = yield* contribution!.collect({ userId: userA });
        assert.strictEqual(contribution?.id, "two_factor");
        const Shape = Schema.Struct({
          enabled: Schema.Boolean,
          confirmedAt: Schema.NullOr(Schema.String),
          remainingRecoveryCodes: Schema.Number,
        });
        const shape = Schema.decodeUnknownSync(Shape)(section);
        assert.isTrue(shape.enabled);
        assert.isNotNull(shape.confirmedAt);
        assert.strictEqual(shape.remainingRecoveryCodes, 2);
        const text = JSON.stringify(section);
        for (const forbidden of ["SUPER-SECRET-ENVELOPE", "SECRET-HASH", "argon2id"]) {
          assert.notInclude(text, forbidden);
        }
        // A user with no factor exports "not enabled", not an error.
        const none = Schema.decodeUnknownSync(Shape)(
          yield* contribution!.collect({ userId: userB }),
        );
        assert.deepStrictEqual(none, {
          enabled: false,
          confirmedAt: null,
          remainingRecoveryCodes: 0,
        });
      }).pipe(Effect.scoped, Effect.provide(RegistryLayer)),
  );
});
