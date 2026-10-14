// Plan 05, phase 1: the `SealedColumn` mechanism, once. Every branch of `open` (canonical,
// an old AAD spelling (now Unreadable), stale key, unknown key, tampered row or column, malformed value, adopted plaintext,
// a lost or failed compare-and-swap, re-seal switched off) and `sweep`, on the SQL swap against
// a real table. The per-plugin wiring suites (`TestAuth.runSealedColumnTests`) prove a plugin
// used its declaration; this proves the declaration works.
import { Encryption } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SealedColumn from "../src/SealedColumn.ts";
import { rotatingKeys } from "./support/RotatingKeys.ts";
import * as TestSql from "../../test/src/TestSql.ts";

const declared = SealedColumn.column({
  table: "sealed_probe",
  column: "secret",
  key: "id",
});

const other = SealedColumn.column({ table: "sealed_probe", column: "other", key: "id" });

const numeric = SealedColumn.column({
  table: "sealed_probe",
  column: "secret",
  key: "id",
  schema: Schema.fromJsonString(Schema.Struct({ n: Schema.Number })),
});

const adopting = SealedColumn.column({
  table: "sealed_probe",
  column: "secret",
  key: "id",
  adoptPlaintext: true,
});

const setup = (suite: string) => {
  const keys = rotatingKeys();
  const sql = TestSql.layer(suite);
  const layer = Layer.merge(keys.layer, sql);
  const prepare = Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient;
    yield* client`CREATE TABLE sealed_probe (id TEXT PRIMARY KEY, secret TEXT, other TEXT)`;
  });
  return { keys, layer, prepare };
};

const raw = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly secret: string | null }>`
      SELECT secret FROM sealed_probe WHERE id = ${id}`;
    return rows[0]?.secret ?? null;
  });

const put = (id: string, stored: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO sealed_probe (id, secret) VALUES (${id}, ${stored})
      ON CONFLICT (id) DO UPDATE SET secret = ${stored}`;
  });

const sealedInto = <A>(column: SealedColumn.Column<A>, id: string, value: A) =>
  Effect.gen(function* () {
    const codec = yield* SealedColumn.codec(column, yield* SealedColumn.sqlSwap(column));
    const stored = yield* codec.seal(id, Redacted.make(value));
    yield* put(id, stored);
    return codec;
  });

const openedReason = <A>(open: Effect.Effect<A, SealedColumn.Unreadable>) =>
  open.pipe(
    Effect.flip,
    Effect.map((unreadable) => unreadable.reason),
  );

describe("SealedColumn.column", () => {
  it("refuses a table, column or key that is not a plain identifier", () => {
    for (const field of ["table", "column", "key"] as const) {
      const options = { table: "t", column: "c", key: "k", [field]: 'x"; DROP TABLE y; --' };
      assert.throws(() => SealedColumn.column(options), "plain SQL identifier");
    }
  });

  it("the canonical AAD is <table>:<rowKey>:<column>", () => {
    assert.strictEqual(SealedColumn.aadOf(declared, "r1"), "sealed_probe:r1:secret");
  });
});

describe("SealedColumn.codec over SQL", () => {
  it.effect("stores an envelope, never the plaintext, and opens to what was written", () => {
    const { layer, prepare } = setup("sealed_canonical");
    return Effect.gen(function* () {
      yield* prepare;
      const codec = yield* sealedInto(declared, "r1", "hunter2");
      const stored = yield* raw("r1");
      assert.isNotNull(stored);
      assert.isTrue(Encryption.looksLikeEnvelope(stored ?? ""));
      assert.notInclude(stored ?? "", "hunter2");
      const opened = yield* codec.sealed("r1", stored ?? "").open;
      assert.strictEqual(Redacted.value(opened), "hunter2");
      assert.strictEqual(yield* raw("r1"), stored, "a current canonical envelope is not rewritten");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a ciphertext moved to another row, or to another column, does not open", () => {
    const { layer, prepare } = setup("sealed_tamper");
    return Effect.gen(function* () {
      yield* prepare;
      const codec = yield* sealedInto(declared, "r1", "hunter2");
      const stored = (yield* raw("r1")) ?? "";
      assert.strictEqual(yield* openedReason(codec.sealed("r2", stored).open), "DecryptionFailed");
      const otherCodec = yield* SealedColumn.codec(other, yield* SealedColumn.sqlSwap(other));
      assert.strictEqual(
        yield* openedReason(otherCodec.sealed("r1", stored).open),
        "DecryptionFailed",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "an envelope sealed under an old AAD spelling is Unreadable (DecryptionFailed) and untouched",
    () => {
      const { layer, prepare } = setup("sealed_old_aad");
      return Effect.gen(function* () {
        yield* prepare;
        const encryption = yield* Encryption.Encryption;
        const old = yield* encryption.encrypt(Redacted.make("hunter2"), "sealed-probe:r1:secret");
        yield* put("r1", old);
        const codec = yield* SealedColumn.codec(declared, yield* SealedColumn.sqlSwap(declared));
        const unreadable = yield* codec.sealed("r1", old).open.pipe(Effect.flip);
        assert.strictEqual(unreadable.reason, "DecryptionFailed");
        assert.deepStrictEqual(
          [unreadable.table, unreadable.column, unreadable.rowKey],
          ["sealed_probe", "secret", "r1"],
        );
        assert.strictEqual(yield* raw("r1"), old, "an unreadable row is never rewritten");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("an envelope under a retired key re-seals to the current key on read", () => {
    const { layer, prepare, keys } = setup("sealed_stale");
    return Effect.gen(function* () {
      yield* prepare;
      const codec = yield* sealedInto(declared, "r1", "hunter2");
      const before = (yield* raw("r1")) ?? "";
      keys.rotateTo("k2");
      assert.strictEqual(Redacted.value(yield* codec.sealed("r1", before).open), "hunter2");
      const after = (yield* raw("r1")) ?? "";
      assert.notStrictEqual(after, before);
      const encryption = yield* Encryption.Encryption;
      const decrypted = yield* encryption.decrypt(after, SealedColumn.aadOf(declared, "r1"));
      assert.isTrue(Option.isNone(decrypted.staleKid), "the stored envelope is on the current key");
    }).pipe(Effect.provide(layer));
  });

  it.effect("an envelope under an unknown key is Unreadable and is never retried", () => {
    const { layer, prepare, keys } = setup("sealed_unknown");
    return Effect.gen(function* () {
      yield* prepare;
      const codec = yield* sealedInto(declared, "r1", "hunter2");
      const stored = (yield* raw("r1")) ?? "";
      keys.retire("k1");
      assert.strictEqual(yield* openedReason(codec.sealed("r1", stored).open), "UnknownKeyId");
      assert.strictEqual(yield* raw("r1"), stored);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a value that does not decode through the column schema is Malformed", () => {
    const { layer, prepare } = setup("sealed_malformed");
    return Effect.gen(function* () {
      yield* prepare;
      const encryption = yield* Encryption.Encryption;
      const stored = yield* encryption.encrypt(
        Redacted.make("not json"),
        SealedColumn.aadOf(numeric, "r1"),
      );
      yield* put("r1", stored);
      const codec = yield* SealedColumn.codec(numeric, yield* SealedColumn.sqlSwap(numeric));
      assert.strictEqual(yield* openedReason(codec.sealed("r1", stored).open), "Malformed");
      const good = yield* sealedInto(numeric, "r2", { n: 42 });
      assert.deepStrictEqual(
        Redacted.value(yield* good.sealed("r2", (yield* raw("r2")) ?? "").open),
        { n: 42 },
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "adoptPlaintext seals a plain legacy value on read; without it the value is Unreadable",
    () => {
      const { layer, prepare } = setup("sealed_adopt");
      return Effect.gen(function* () {
        yield* prepare;
        yield* put("r1", "plain-value");
        const strict = yield* SealedColumn.codec(declared, yield* SealedColumn.sqlSwap(declared));
        assert.strictEqual(
          yield* openedReason(strict.sealed("r1", "plain-value").open),
          "DecryptionFailed",
        );
        const adopt = yield* SealedColumn.codec(adopting, yield* SealedColumn.sqlSwap(adopting));
        assert.strictEqual(
          Redacted.value(yield* adopt.sealed("r1", "plain-value").open),
          "plain-value",
        );
        assert.isTrue(Encryption.looksLikeEnvelope((yield* raw("r1")) ?? ""));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "a lost compare-and-swap leaves the other writer's value and the read still succeeds",
    () => {
      const { layer, prepare, keys } = setup("sealed_lost_cas");
      return Effect.gen(function* () {
        yield* prepare;
        yield* sealedInto(declared, "r1", "hunter2");
        const before = (yield* raw("r1")) ?? "";
        keys.rotateTo("k2");
        const real = yield* SealedColumn.sqlSwap(declared);
        const sql = yield* SqlClient.SqlClient;
        const encryption = yield* Encryption.Encryption;
        // Another writer re-seals the same row between our read and our swap.
        const racing: SealedColumn.Swap = (rowKey, stored, fresh) =>
          Effect.gen(function* () {
            const theirs = yield* encryption.encrypt(
              Redacted.make("hunter2"),
              SealedColumn.aadOf(declared, rowKey),
            );
            yield* put(rowKey, theirs).pipe(Effect.provideService(SqlClient.SqlClient, sql));
            return yield* real(rowKey, stored, fresh);
          });
        const codec = yield* SealedColumn.codec(declared, racing);
        assert.strictEqual(Redacted.value(yield* codec.sealed("r1", before).open), "hunter2");
        const after = (yield* raw("r1")) ?? "";
        assert.notStrictEqual(after, before);
        const second = yield* codec.sealed("r1", after).open;
        assert.strictEqual(Redacted.value(second), "hunter2", "their envelope is intact");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a swap that fails is logged and never fails the read", () => {
    const { layer, prepare, keys } = setup("sealed_failed_swap");
    return Effect.gen(function* () {
      yield* prepare;
      yield* sealedInto(declared, "r1", "hunter2");
      const before = (yield* raw("r1")) ?? "";
      keys.rotateTo("k2");
      const codec = yield* SealedColumn.codec(declared, () => Effect.fail("replica is read-only"));
      assert.strictEqual(Redacted.value(yield* codec.sealed("r1", before).open), "hunter2");
      assert.strictEqual(yield* raw("r1"), before);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resealOnRead: false reads without writing", () => {
    const { layer, prepare, keys } = setup("sealed_no_reseal");
    return Effect.gen(function* () {
      yield* prepare;
      yield* sealedInto(declared, "r1", "hunter2");
      const before = (yield* raw("r1")) ?? "";
      keys.rotateTo("k2");
      const codec = yield* SealedColumn.codec(declared, yield* SealedColumn.sqlSwap(declared)).pipe(
        Effect.provideService(SealedColumn.SealedColumnConfig, { resealOnRead: false }),
      );
      assert.strictEqual(Redacted.value(yield* codec.sealed("r1", before).open), "hunter2");
      assert.strictEqual(yield* raw("r1"), before);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "reveal refreshes a stale-key or adopted value, not a current one, and opens the canonical AAD only",
    () => {
      const { layer, keys } = setup("sealed_reveal");
      return Effect.gen(function* () {
        const encryption = yield* Encryption.Encryption;
        const options = { aad: "sealed-probe:r1:secret" };
        const canonical = yield* encryption.encrypt(Redacted.make("v"), options.aad);
        const fresh = yield* SealedColumn.reveal(encryption, options, canonical);
        assert.isTrue(Option.isNone(fresh.refreshed));
        const old = yield* encryption.encrypt(Redacted.make("v"), "sealed-probe:r1:old");
        const failure = yield* SealedColumn.reveal(encryption, options, old).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "DecryptionFailed");
        keys.rotateTo("k2");
        const stale = yield* SealedColumn.reveal(encryption, options, canonical);
        assert.isTrue(Option.isSome(stale.refreshed));
        const adopted = yield* SealedColumn.reveal(
          encryption,
          { ...options, adoptPlaintext: true },
          "plain",
        );
        assert.isTrue(Option.isSome(adopted.refreshed));
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("SealedColumn call-site treatments", () => {
  it.effect("orDie turns Unreadable into a defect naming the column, never the value", () => {
    const { layer, prepare } = setup("sealed_ordie");
    return Effect.gen(function* () {
      yield* prepare;
      const codec = yield* SealedColumn.codec(declared, yield* SealedColumn.sqlSwap(declared));
      const exit = yield* Effect.exit(SealedColumn.orDie(codec.sealed("r1", "garbage").open));
      assert.isTrue(exit._tag === "Failure");
      const text = JSON.stringify(exit, (_, v) => (v instanceof Error ? v.message : v));
      assert.include(text, "sealedColumn.readable");
      assert.include(text, "sealed_probe.secret");
    }).pipe(Effect.provide(layer));
  });

  it.effect("option degrades one value to None", () => {
    const { layer, prepare } = setup("sealed_option");
    return Effect.gen(function* () {
      yield* prepare;
      const codec = yield* SealedColumn.codec(declared, yield* SealedColumn.sqlSwap(declared));
      assert.isTrue(Option.isNone(yield* SealedColumn.option(codec.sealed("r1", "garbage").open)));
      yield* sealedInto(declared, "r2", "ok");
      const good = yield* SealedColumn.option(codec.sealed("r2", (yield* raw("r2")) ?? "").open);
      assert.strictEqual(Option.map(good, Redacted.value).pipe(Option.getOrNull), "ok");
    }).pipe(Effect.provide(layer));
  });
});

describe("SealedColumn.sweep", () => {
  it.effect("re-seals stale values, leaves unreadable ones, and a second run does nothing", () => {
    const { layer, prepare, keys } = setup("sealed_sweep");
    return Effect.gen(function* () {
      yield* prepare;
      yield* sealedInto(declared, "a-canonical", "one");
      yield* sealedInto(declared, "c-stale", "three");
      yield* put("d-garbage", "not an envelope");
      yield* put("e-null", null);
      // Only c-stale is on the old key if the others are written after the rotation.
      keys.rotateTo("k2");
      yield* sealedInto(declared, "a-canonical", "one");
      const first = yield* SealedColumn.sweep(declared, { batch: 2 });
      assert.deepStrictEqual(first, { scanned: 3, resealed: 1, unreadable: 1 });
      const second = yield* SealedColumn.sweep(declared, { batch: 2 });
      assert.deepStrictEqual(second, { scanned: 3, resealed: 0, unreadable: 1 });
      assert.strictEqual(yield* raw("d-garbage"), "not an envelope");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "a row sealed under an old AAD spelling is counted unreadable and never rewritten",
    () => {
      const { layer, prepare } = setup("sealed_sweep_old_aad");
      return Effect.gen(function* () {
        yield* prepare;
        const encryption = yield* Encryption.Encryption;
        const old = yield* encryption.encrypt(Redacted.make("two"), "sealed-probe:r1:secret");
        yield* put("r1", old);
        const report = yield* SealedColumn.sweep(declared);
        assert.deepStrictEqual(report, { scanned: 1, resealed: 0, unreadable: 1 });
        assert.strictEqual(yield* raw("r1"), old);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("SealedColumn.sweepAll", () => {
  /** Rows in two columns sealed canonically under k1, then the current key moves to k2. */
  const seedStale = (keys: { readonly rotateTo: (kid: "k2") => void }) =>
    Effect.gen(function* () {
      const encryption = yield* Encryption.Encryption;
      const sql = yield* SqlClient.SqlClient;
      for (const id of ["r1", "r2"]) {
        yield* sql`INSERT INTO sealed_probe (id, secret, other) VALUES (
          ${id},
          ${yield* encryption.encrypt(Redacted.make(`s-${id}`), SealedColumn.aadOf(declared, id))},
          ${yield* encryption.encrypt(Redacted.make(`o-${id}`), SealedColumn.aadOf(other, id))})`;
      }
      keys.rotateTo("k2");
    });

  it.effect(
    "reports one entry per column in order and logs one Info summary per column, ids and counts only",
    () => {
      const { layer, prepare, keys } = setup("sealed_sweep_all");
      return Effect.gen(function* () {
        yield* prepare;
        yield* seedStale(keys);
        const logged: Array<{ readonly level: string; readonly annotations: string }> = [];
        const capture = Logger.make<unknown, void>((entry) => {
          logged.push({
            level: entry.logLevel,
            annotations: JSON.stringify(entry.fiber.getRef(References.CurrentLogAnnotations)),
          });
        });
        const reports = yield* SealedColumn.sweepAll([declared, other], { batch: 1 }).pipe(
          Effect.provide(Logger.layer([capture])),
        );
        assert.deepStrictEqual(reports, [
          { table: "sealed_probe", column: "secret", scanned: 2, resealed: 2, unreadable: 0 },
          { table: "sealed_probe", column: "other", scanned: 2, resealed: 2, unreadable: 0 },
        ]);
        assert.deepStrictEqual(
          logged.map((entry) => entry.level),
          ["Info", "Info"],
        );
        assert.include(logged[0]?.annotations ?? "", '"column":"secret"');
        assert.include(logged[1]?.annotations ?? "", '"resealed":2');
        for (const entry of logged) {
          assert.notInclude(entry.annotations, "s-r1");
          assert.notInclude(entry.annotations, "o-r1");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a second sweepAll re-seals nothing", () => {
    const { layer, prepare, keys } = setup("sealed_sweep_all_again");
    return Effect.gen(function* () {
      yield* prepare;
      yield* seedStale(keys);
      yield* SealedColumn.sweepAll([declared, other]);
      const again = yield* SealedColumn.sweepAll([declared, other]);
      assert.deepStrictEqual(
        again.map((report) => [report.resealed, report.unreadable]),
        [
          [0, 0],
          [0, 0],
        ],
      );
    }).pipe(Effect.provide(layer));
  });
});
