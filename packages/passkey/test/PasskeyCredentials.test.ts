// spec/behaviors/17-passkey.md, BEH-EA-130/134.
//
// The same contract suite runs against `layerMemory` and `layerSql` — the
// same pattern `packages/core/test/Accounts.test.ts` etc. use for their own
// two `Layer`s. `layerSql` here is migrated via `Passkey.Passkey`'s own
// real `migrations` (`Migrations.run`, `@awthaq/core`) rather than a
// hand-rolled inline `CREATE TABLE` — BAM-002 (.issues/high) verification,
// the same `packages/jwt/test/RevocationStore.test.ts` establishes.
import { Migrations, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Passkey from "../src/Passkey.ts";
import * as PasskeyCredentials from "../src/PasskeyCredentials.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

const MemoryLayer = PasskeyCredentials.layerMemory;

const SqlLive = TestSql.layer("passkey_PasskeyCredentials");

const Migrated = Layer.effectDiscard(Migrations.run(Passkey.Passkey.migrations)).pipe(
  Layer.provide(SqlLive),
);

const SqlLayer = PasskeyCredentials.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const userA = Users.UserId("user-a");
const userB = Users.UserId("user-b");

const suite = (
  name: string,
  layer: Layer.Layer<PasskeyCredentials.PasskeyCredentials, unknown, never>,
): void => {
  describe(name, () => {
    it.effect("create then findById round-trips every field", () =>
      Effect.gen(function* () {
        const credentials = yield* PasskeyCredentials.PasskeyCredentials;
        yield* credentials.create({
          id: "cred-1",
          userId: userA,
          webauthnUserId: "wau-1",
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          deviceType: "singleDevice",
          backedUp: false,
          transports: ["internal"],
          aaguid: "00000000-0000-0000-0000-000000000000",
          name: "My Passkey",
        });
        const found = yield* credentials.findById("cred-1");
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) {
          assert.strictEqual(found.value.userId, userA);
          assert.deepStrictEqual(found.value.publicKey, new Uint8Array([1, 2, 3]));
          assert.deepStrictEqual(found.value.transports, ["internal"]);
          assert.strictEqual(found.value.name, "My Passkey");
        }
      }).pipe(Effect.provide(layer)),
    );

    it.effect("listByUser only lists the current user's own credentials", () =>
      Effect.gen(function* () {
        const credentials = yield* PasskeyCredentials.PasskeyCredentials;
        yield* credentials.create({
          id: "cred-list-a1",
          userId: userA,
          webauthnUserId: "wau-a1",
          publicKey: new Uint8Array([1]),
          counter: 0,
          deviceType: "singleDevice",
          backedUp: false,
          transports: [],
          aaguid: "00000000-0000-0000-0000-000000000000",
          name: "A1",
        });
        yield* credentials.create({
          id: "cred-list-b1",
          userId: userB,
          webauthnUserId: "wau-b1",
          publicKey: new Uint8Array([2]),
          counter: 0,
          deviceType: "singleDevice",
          backedUp: false,
          transports: [],
          aaguid: "00000000-0000-0000-0000-000000000000",
          name: "B1",
        });
        const listed = yield* credentials.listByUser(userA);
        assert.isTrue(listed.every((row) => row.userId === userA));
        assert.isTrue(listed.some((row) => row.id === "cred-list-a1"));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("recordUsage updates counter/backedUp/lastUsedAt", () =>
      Effect.gen(function* () {
        const credentials = yield* PasskeyCredentials.PasskeyCredentials;
        yield* credentials.create({
          id: "cred-usage",
          userId: userA,
          webauthnUserId: "wau-usage",
          publicKey: new Uint8Array([9]),
          counter: 0,
          deviceType: "singleDevice",
          backedUp: false,
          transports: [],
          aaguid: "00000000-0000-0000-0000-000000000000",
          name: "Usage",
        });
        yield* credentials.recordUsage("cred-usage", 7, true);
        const found = yield* credentials.findById("cred-usage");
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) {
          assert.strictEqual(found.value.counter, 7);
          assert.isTrue(found.value.backedUp);
        }
      }).pipe(Effect.provide(layer)),
    );

    it.effect("rename fails for a credential belonging to another user", () =>
      Effect.gen(function* () {
        const credentials = yield* PasskeyCredentials.PasskeyCredentials;
        yield* credentials.create({
          id: "cred-rename",
          userId: userA,
          webauthnUserId: "wau-rename",
          publicKey: new Uint8Array([3]),
          counter: 0,
          deviceType: "singleDevice",
          backedUp: false,
          transports: [],
          aaguid: "00000000-0000-0000-0000-000000000000",
          name: "Original",
        });
        const wrongOwner = yield* credentials
          .rename("cred-rename", userB, "Stolen")
          .pipe(Effect.flip);
        assert.strictEqual(wrongOwner._tag, "PasskeyCredentialNotFound");
        const renamed = yield* credentials.rename("cred-rename", userA, "Renamed");
        assert.strictEqual(renamed.name, "Renamed");
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "delete fails identically for an unknown id and for one owned by another user, succeeds for the real owner",
      () =>
        Effect.gen(function* () {
          const credentials = yield* PasskeyCredentials.PasskeyCredentials;
          yield* credentials.create({
            id: "cred-delete",
            userId: userA,
            webauthnUserId: "wau-delete",
            publicKey: new Uint8Array([4]),
            counter: 0,
            deviceType: "singleDevice",
            backedUp: false,
            transports: [],
            aaguid: "00000000-0000-0000-0000-000000000000",
            name: "Delete me",
          });
          const unknown = yield* credentials.delete("does-not-exist", userA).pipe(Effect.flip);
          const wrongOwner = yield* credentials.delete("cred-delete", userB).pipe(Effect.flip);
          assert.strictEqual(unknown._tag, "PasskeyCredentialNotFound");
          assert.strictEqual(wrongOwner._tag, "PasskeyCredentialNotFound");
          yield* credentials.delete("cred-delete", userA);
          const found = yield* credentials.findById("cred-delete");
          assert.isTrue(Option.isNone(found));
        }).pipe(Effect.provide(layer)),
    );

    const seed = (id: string, userId: Users.UserId) => ({
      id,
      userId,
      webauthnUserId: `wau-${id}`,
      publicKey: new Uint8Array([9, 9]),
      counter: 0,
      deviceType: "singleDevice" as const,
      backedUp: false,
      transports: [],
      aaguid: "00000000-0000-0000-0000-000000000000",
      name: id,
    });

    // WPS-010: both layers refuse a duplicate credential id identically — the
    // memory layer used to silently re-own it, the SQL layer died on the PK.
    it.effect(
      "WPS-010: creating an existing credential id fails PasskeyCredentialAlreadyExists and leaves the original owner intact",
      () =>
        Effect.gen(function* () {
          const credentials = yield* PasskeyCredentials.PasskeyCredentials;
          yield* credentials.create(seed("cred-dup", userA));
          const failure = yield* credentials.create(seed("cred-dup", userB)).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "PasskeyCredentialAlreadyExists");
          const found = yield* credentials.findById("cred-dup");
          assert.isTrue(Option.isSome(found));
          if (Option.isSome(found)) assert.strictEqual(found.value.userId, userA);
        }).pipe(Effect.provide(layer)),
    );

    // CB-004: the stored counter only moves forward, so a clone replaying an
    // old value keeps tripping the regression check.
    it.effect("CB-004: recordUsage never lowers the stored counter", () =>
      Effect.gen(function* () {
        const credentials = yield* PasskeyCredentials.PasskeyCredentials;
        yield* credentials.create(seed("cred-counter", userA));
        yield* credentials.recordUsage("cred-counter", 5, false);
        yield* credentials.recordUsage("cred-counter", 3, false);
        const found = yield* credentials.findById("cred-counter");
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) assert.strictEqual(found.value.counter, 5);
        yield* credentials.recordUsage("cred-counter", 9, false);
        const advanced = yield* credentials.findById("cred-counter");
        if (Option.isSome(advanced)) assert.strictEqual(advanced.value.counter, 9);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("WPS-006: flagCounterAnomaly stamps the credential and counts each anomaly", () =>
      Effect.gen(function* () {
        const credentials = yield* PasskeyCredentials.PasskeyCredentials;
        yield* credentials.create(seed("cred-flag", userA));
        const before = yield* credentials.findById("cred-flag");
        assert.isTrue(Option.isSome(before));
        if (Option.isSome(before)) {
          assert.isTrue(Option.isNone(before.value.counterAnomalyAt));
          assert.strictEqual(before.value.counterAnomalyCount, 0);
        }
        yield* credentials.flagCounterAnomaly("cred-flag");
        yield* credentials.flagCounterAnomaly("cred-flag");
        const after = yield* credentials.findById("cred-flag");
        assert.isTrue(Option.isSome(after));
        if (Option.isSome(after)) {
          assert.isTrue(Option.isSome(after.value.counterAnomalyAt));
          assert.strictEqual(after.value.counterAnomalyCount, 2);
        }
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "WPS-006: flagCounterAnomaly on an unknown credential is PasskeyCredentialNotFound",
      () =>
        Effect.gen(function* () {
          const credentials = yield* PasskeyCredentials.PasskeyCredentials;
          const failure = yield* credentials.flagCounterAnomaly("nope").pipe(Effect.flip);
          assert.strictEqual(failure._tag, "PasskeyCredentialNotFound");
        }).pipe(Effect.provide(layer)),
    );
  });
};

suite("PasskeyCredentials (layerMemory)", MemoryLayer);
suite("PasskeyCredentials (layerSql)", SqlLayer);
