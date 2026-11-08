// THS-001 step 3, BCR-002, THS-005 (BEH-EA-264/265): what is not a store contract — the erasure and export
// contributions over the stores, and the sealed `secret` column's wiring suite over both adapters — on a real database
// (SQLite by default, Postgres under `AWTHAQ_POSTGRES_URL`/`pnpm run test:pg`) with the plugin's real migrations.
// The two stores' own cases are `RecordsContract` suites (`test/contract/`, run from `Contract.test.ts`, plan 25
// ticket 21). Hand-built layers, not `RecordsContract.recordsBase`: the sealed suite needs the secrets layer without
// `Encryption` (it provides a rotatable one) and the memory adapter's `MemoryEnvelopes` seam.
import { DataExport, Erasure, Migrations, Users } from "@awthaq/core";
import { PasswordHasher } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { TestSql } from "@awthaq/test";
import * as TwoFactor from "../src/TwoFactor.ts";
import * as TwoFactorStore from "../src/TwoFactorStore.ts";
import { EncryptionLive } from "./support/harness.ts";

const SqlLive = TestSql.layer("two_factor_TwoFactorStore");

const Migrated = Layer.effectDiscard(Migrations.run(TwoFactor.TwoFactor.migrations)).pipe(
  Layer.provide(SqlLive),
);

// The secrets layers need `Encryption` (the sealed `secret` column); the sealed suite below provides a
// rotatable one itself.
const SqlNeedsEncryption = Layer.mergeAll(
  TwoFactorStore.layerSecretsSql,
  TwoFactorStore.layerRecoveryCodesSql,
).pipe(Layer.provide(NodeCrypto.layer), Layer.provideMerge(SqlLive), Layer.provideMerge(Migrated));
const SqlStores = SqlNeedsEncryption.pipe(Layer.provide(EncryptionLive));

const hash = (text: string) => PasswordHasher.PhcHash(`$argon2id$test$${text}`);
const userA = Users.UserId("user-a");
const userB = Users.UserId("user-b");

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
      yield* secrets.upsertPending(userA, Redacted.make("a"));
      yield* secrets.upsertPending(userB, Redacted.make("b"));
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
        yield* secrets.upsertPending(userA, Redacted.make("SUPER-SECRET-ENVELOPE"));
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

// ---- the sealed `secret` column: the substrate's wiring suite over both adapters ----------------------------
// (replaces the old `reencrypt` test: the compare-and-swap is the mechanism suite's lost-swap case)

const vitestFramework: TestAuth.TestFramework = {
  describe: (name, body) => describe(name, body),
  it: (name, body) => it(name, body),
  fail: (message) => assert.fail(message),
};

const writeSecret = (rowKey: string, value: string) =>
  Effect.flatMap(TwoFactorStore.TwoFactorSecrets, (secrets) =>
    Effect.asVoid(secrets.upsertPending(Users.UserId(rowKey), Redacted.make(value))),
  );
const readSecret = (rowKey: string) =>
  Effect.flatMap(TwoFactorStore.TwoFactorSecrets, (secrets) =>
    Effect.map(secrets.find(Users.UserId(rowKey)), (found) => Option.getOrThrow(found).secret),
  );

TestAuth.runSealedColumnTests<
  string,
  TwoFactorStore.TwoFactorSecrets | TwoFactorStore.MemoryEnvelopes
>(vitestFramework, {
  column: TwoFactorStore.secretColumn,
  sample: "JBSWY3DPEHPK3PXP",
  adapters: [
    {
      name: "layerMemory",
      layer: TwoFactorStore.layerSecretsMemory,
      raw: (rowKey) =>
        Effect.flatMap(TwoFactorStore.MemoryEnvelopes, (rows) => rows.stored(Users.UserId(rowKey))),
      plant: (rowKey, stored) =>
        Effect.flatMap(TwoFactorStore.MemoryEnvelopes, (rows) =>
          rows.plant(Users.UserId(rowKey), stored),
        ),
    },
  ],
  write: writeSecret,
  read: readSecret,
});

TestAuth.runSealedColumnTests<
  string,
  TwoFactorStore.TwoFactorSecrets | TwoFactorStore.TwoFactorRecoveryCodes | SqlClient.SqlClient
>(vitestFramework, {
  column: TwoFactorStore.secretColumn,
  sample: "JBSWY3DPEHPK3PXP",
  adapters: [
    {
      name: "layerSql",
      layer: SqlNeedsEncryption,
      raw: (rowKey) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            readonly value: string;
          }>`SELECT secret AS value FROM two_factor_secret WHERE "userId" = ${rowKey}`;
          return rows[0]?.value ?? "";
        }),
      plant: (rowKey, stored) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE two_factor_secret SET secret = ${stored} WHERE "userId" = ${rowKey}`;
        }),
    },
  ],
  write: writeSecret,
  read: readSecret,
});

// Plan 17: the plugin declares its sealed column, so `auth.sealedColumns` (the `also` of a rotation sweep) lists it.
describe("TwoFactorStore sealed column declaration", () => {
  it("the plugin declares the TOTP secret", () => {
    assert.deepStrictEqual(TwoFactor.TwoFactor.sealedColumns, [TwoFactorStore.secretColumn]);
  });
});
