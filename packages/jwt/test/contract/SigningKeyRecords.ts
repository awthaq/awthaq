// Plan 25 ticket 20 (ADR-EA-041 decision 9): `SigningKeyRecords`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`, a fresh store per case. BEH-EA-296: at most one key is current
// (JJS-004/KRS-009: `create` of a second current key is `CurrentKeyConflict`, `markRotated` is a compare-and-swap),
// a rotated key verifies until its `retiresAt`, `retire` only ever shortens a grace period (N12/KRS-008), and a `kid`
// names one key forever (plan 24 R6, Q3): the same public key again answers the stored record, any other key under a
// stored `kid` is `KidTaken`. The ring built on top (lazy mint, rotation, import, remote keys) is `KeyRing.test.ts`.
import { RecordsContract, TestSql } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scheduler from "effect/Scheduler";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import type { Algorithm } from "../../src/JwtCodec.ts";
import * as SigningKeyRecords from "../../src/SigningKeyRecords.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);

const EdDSA: Algorithm = "EdDSA";

const publicJwk = (x: string): SigningKeyRecords.Jwk => ({ kty: "OKP", crv: "Ed25519", x });

/** A locally minted key: a public JWK and a sealed private half. */
const localKey = (kid: string) => ({
  kid,
  alg: EdDSA,
  publicKeyJwk: publicJwk(`pub-${kid}`),
  privateKeyJwk: Option.some(Redacted.make({ ...publicJwk(`pub-${kid}`), d: `priv-${kid}` })),
});

/** A remote (or imported) key: the public half only. */
const publicKey = (kid: string, x = `pub-${kid}`) => ({
  kid,
  alg: EdDSA,
  publicKeyJwk: publicJwk(x),
  privateKeyJwk: Option.none(),
});

const rotated = (rotatedAt: number, retiresAt: number) => ({
  rotated: { rotatedAt: at(rotatedAt), retiresAt: at(retiresAt) },
});

const millisOf = (value: Option.Option<DateTime.Utc>) =>
  Option.getOrNull(Option.map(value, DateTime.toEpochMillis));

/** A record without its sealed half, its instants as epoch millis: comparable on every adapter. */
const plain = (record: SigningKeyRecords.SigningKeyRecord) => ({
  kid: record.kid,
  alg: record.alg,
  publicKeyJwk: record.publicKeyJwk,
  hasPrivate: Option.isSome(record.privateKeyJwk),
  createdAt: DateTime.toEpochMillis(record.createdAt),
  rotatedAt: millisOf(record.rotatedAt),
  retiresAt: millisOf(record.retiresAt),
});

const stored = (kid: string) =>
  Effect.flatMap(SigningKeyRecords.SigningKeyRecords, (records) =>
    Effect.map(records.findByKid(kid), Option.getOrThrow),
  );

const currentKid = Effect.flatMap(SigningKeyRecords.SigningKeyRecords, (records) =>
  Effect.map(records.findCurrent(), (current) =>
    Option.getOrNull(Option.map(current, (r) => r.kid)),
  ),
);

/** The private half stored under `kid`, opened. */
const privateOf = (kid: string) =>
  Effect.flatMap(stored(kid), (record) =>
    Effect.map(Option.getOrThrow(record.privateKeyJwk).open, Redacted.value),
  );

/**
 * Racing fibers yield to the scheduler every few steps, so they interleave between a read and a write.
 * (Effect 4.1.2 stalls with a budget below 4.)
 */
const fineGrained = Effect.provideService(Scheduler.MaxOpsBeforeYield, 4);

/** Whether `name` is an index of the migrated schema, and its definition. */
const indexDefinition = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.onDialectOrElse({
      pg: () => sql<{ readonly sql: string | null }>`
        SELECT indexdef AS sql FROM pg_indexes
        WHERE schemaname = current_schema() AND indexname = ${name}`,
      orElse: () => sql<{ readonly sql: string | null }>`
        SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ${name}`,
    });
    return rows.map((row) => row.sql ?? "");
  });

export const signingKeyRecords = RecordsContract.suite(SigningKeyRecords.SigningKeyRecords, {
  operations: {
    create: {
      atomic: [
        {
          name: "a current key reads back field for field, its private half sealed and opening to what was written",
          run: Effect.gen(function* () {
            const records = yield* SigningKeyRecords.SigningKeyRecords;
            yield* TestClock.adjust("1 second");
            const created = yield* records.create(localKey("k1"));
            const expected = {
              kid: "k1",
              alg: EdDSA,
              publicKeyJwk: publicJwk("pub-k1"),
              hasPrivate: true,
              createdAt: 1_000,
              rotatedAt: null,
              retiresAt: null,
            };
            assert.deepStrictEqual(plain(created), expected);
            assert.deepStrictEqual(plain(yield* stored("k1")), expected);
            assert.deepStrictEqual(yield* privateOf("k1"), {
              ...publicJwk("pub-k1"),
              d: "priv-k1",
            });
            assert.strictEqual(yield* currentKid, "k1");
          }),
        },
        {
          name: "a second current key is CurrentKeyConflict and the first stays current",
          run: Effect.gen(function* () {
            const records = yield* SigningKeyRecords.SigningKeyRecords;
            yield* records.create(localKey("k1"));
            const conflict = yield* Effect.flip(records.create(publicKey("k2")));
            assert.strictEqual(conflict._tag, "CurrentKeyConflict");
            assert.strictEqual(yield* currentKid, "k1");
            assert.isTrue(Option.isNone(yield* records.findByKid("k2")));
          }),
        },
        {
          name: "a key inserted rotated never competes for the current slot and verifies until its retiresAt",
          run: Effect.gen(function* () {
            const records = yield* SigningKeyRecords.SigningKeyRecords;
            yield* records.create(localKey("k1"));
            const imported = yield* records.create({
              ...publicKey("foreign"),
              ...rotated(0, 5_000),
            });
            assert.strictEqual(millisOf(imported.rotatedAt), 0);
            assert.strictEqual(millisOf(imported.retiresAt), 5_000);
            assert.isTrue(Option.isNone(imported.privateKeyJwk));
            assert.strictEqual(yield* currentKid, "k1");
            assert.deepStrictEqual(
              (yield* records.listVerifiable(at(4_999))).map((r) => r.kid).sort(),
              ["foreign", "k1"],
            );
          }),
        },
        {
          name: "R6: a different key under a stored kid is KidTaken and the stored key, private half included, is untouched",
          run: Effect.gen(function* () {
            const records = yield* SigningKeyRecords.SigningKeyRecords;
            yield* records.create(localKey("k1"));
            const before = plain(yield* stored("k1"));
            // A different public key under the current key's kid, as current and as rotated.
            const asCurrent = yield* Effect.flip(records.create(publicKey("k1", "other")));
            assert.strictEqual(asCurrent._tag, "SigningKeyRecords/KidTaken");
            const asRotated = yield* Effect.flip(
              records.create({ ...publicKey("k1", "other"), ...rotated(0, 9_000) }),
            );
            assert.strictEqual(asRotated._tag, "SigningKeyRecords/KidTaken");
            // The same public key, but carrying a private half: a key with private material is never "the same again".
            const withPrivate = yield* Effect.flip(records.create(localKey("k1")));
            assert.strictEqual(withPrivate._tag, "SigningKeyRecords/KidTaken");
            assert.deepStrictEqual(plain(yield* stored("k1")), before);
            assert.deepStrictEqual(yield* privateOf("k1"), {
              ...publicJwk("pub-k1"),
              d: "priv-k1",
            });
            // A different algorithm under a rotated key's kid, while a current key exists.
            yield* records.create({ ...publicKey("old"), ...rotated(0, 9_000) });
            const otherAlg = yield* Effect.flip(
              records.create({ ...publicKey("old"), alg: "ES256", ...rotated(0, 9_000) }),
            );
            assert.strictEqual(otherAlg._tag, "SigningKeyRecords/KidTaken");
            assert.strictEqual(yield* currentKid, "k1");
          }),
        },
        {
          name: "Q3: the same public key again under its kid answers the stored record unchanged, current or rotated",
          run: Effect.gen(function* () {
            const records = yield* SigningKeyRecords.SigningKeyRecords;
            const first = yield* records.create(publicKey("remote"));
            yield* TestClock.adjust("1 hour");
            // Again as a current key (while it is itself the current key), with its JWK members in another order.
            const again = yield* records.create({
              ...publicKey("remote"),
              publicKeyJwk: { x: "pub-remote", crv: "Ed25519", kty: "OKP" },
            });
            assert.deepStrictEqual(plain(again), plain(first));
            // Again as a rotated key: nothing changes, the key stays current.
            const asRotated = yield* records.create({ ...publicKey("remote"), ...rotated(0, 1) });
            assert.deepStrictEqual(plain(asRotated), plain(first));
            assert.strictEqual(yield* currentKid, "remote");
            // A rotated key re-created as current stays rotated and takes no current slot.
            yield* records.create({ ...publicKey("foreign"), ...rotated(0, 9_000_000) });
            const foreignAgain = yield* records.create(publicKey("foreign"));
            assert.strictEqual(millisOf(foreignAgain.rotatedAt), 0);
            assert.strictEqual(yield* currentKid, "remote");
            assert.strictEqual((yield* records.listVerifiable(at(0))).length, 2);
          }),
        },
      ],
      race: [
        {
          name: "8 creates of a current key leave one current: one succeeds, 7 are CurrentKeyConflict",
          run: Effect.gen(function* () {
            const records = yield* SigningKeyRecords.SigningKeyRecords;
            let next = 0;
            const results = yield* RecordsContract.race(
              Effect.suspend(() => {
                next += 1;
                const kid = `k${next}`;
                return records.create(localKey(kid)).pipe(
                  Effect.map(() => ({ kid, won: true })),
                  Effect.catchTag("CurrentKeyConflict", () => Effect.succeed({ kid, won: false })),
                );
              }),
            ).pipe(fineGrained);
            const winners = results.filter((result) => result.won);
            assert.strictEqual(winners.length, 1);
            assert.strictEqual(yield* currentKid, winners[0]?.kid);
            assert.strictEqual((yield* records.listVerifiable(at(0))).length, 1);
          }),
        },
        {
          name: "8 registrations of one public key under one kid all answer it, and one row is stored",
          run: Effect.gen(function* () {
            const records = yield* SigningKeyRecords.SigningKeyRecords;
            const results = yield* RecordsContract.race(records.create(publicKey("remote"))).pipe(
              fineGrained,
            );
            assert.strictEqual(results.length, RecordsContract.CONCURRENCY);
            assert.isTrue(results.every((record) => record.kid === "remote"));
            assert.strictEqual(yield* currentKid, "remote");
            assert.strictEqual((yield* records.listVerifiable(at(0))).length, 1);
          }),
        },
        {
          name: "8 different keys under one kid: one is stored, 7 are KidTaken",
          run: Effect.gen(function* () {
            const records = yield* SigningKeyRecords.SigningKeyRecords;
            let next = 0;
            const results = yield* RecordsContract.race(
              Effect.suspend(() => {
                next += 1;
                const x = `pub-${next}`;
                return records.create({ ...publicKey("shared", x), ...rotated(0, 9_000) }).pipe(
                  Effect.map(() => ({ x, won: true })),
                  Effect.catchTag("SigningKeyRecords/KidTaken", () =>
                    Effect.succeed({ x, won: false }),
                  ),
                );
              }),
            ).pipe(fineGrained);
            const winners = results.filter((result) => result.won);
            assert.strictEqual(winners.length, 1);
            assert.deepStrictEqual(
              (yield* stored("shared")).publicKeyJwk,
              publicJwk(winners[0]?.x ?? ""),
            );
          }),
        },
      ],
    },
    findByKid: {
      read: [
        {
          name: "finds a key whatever its state, a retired one included; an unknown kid is None",
          run: Effect.gen(function* () {
            const records = yield* SigningKeyRecords.SigningKeyRecords;
            yield* records.create({ ...publicKey("retired"), ...rotated(0, 1) });
            assert.strictEqual((yield* stored("retired")).kid, "retired");
            assert.isFalse((yield* records.listVerifiable(at(5))).some((r) => r.kid === "retired"));
            assert.isTrue(Option.isNone(yield* records.findByKid("nope")));
          }),
        },
      ],
    },
    findCurrent: {
      read: [
        {
          name: "None on an empty store and when every key is rotated; never a rotated key",
          run: Effect.gen(function* () {
            const records = yield* SigningKeyRecords.SigningKeyRecords;
            assert.isTrue(Option.isNone(yield* records.findCurrent()));
            yield* records.create({ ...publicKey("old"), ...rotated(0, 9_000) });
            assert.isTrue(Option.isNone(yield* records.findCurrent()));
            yield* records.create(localKey("k1"));
            assert.strictEqual(yield* currentKid, "k1");
          }),
        },
      ],
    },
    listVerifiable: {
      read: [
        {
          name: "every key not past its retiresAt, newest first; a key retiring exactly now is out",
          run: Effect.gen(function* () {
            const records = yield* SigningKeyRecords.SigningKeyRecords;
            yield* records.create({ ...publicKey("a"), ...rotated(0, 2_000) });
            yield* TestClock.adjust("1 second");
            yield* records.create({ ...publicKey("b"), ...rotated(0, 3_000) });
            yield* TestClock.adjust("1 second");
            yield* records.create(localKey("c"));
            const kids = (now: number) =>
              Effect.map(records.listVerifiable(at(now)), (rows) => rows.map((r) => r.kid));
            assert.deepStrictEqual(yield* kids(1_999), ["c", "b", "a"]);
            assert.deepStrictEqual(yield* kids(2_000), ["c", "b"]);
            assert.deepStrictEqual(yield* kids(10_000), ["c"]);
          }),
        },
      ],
    },
    markRotated: {
      atomic: [
        {
          name: "rotates the current key once: a second call answers false and keeps the first grace period",
          run: Effect.gen(function* () {
            const records = yield* SigningKeyRecords.SigningKeyRecords;
            yield* records.create(localKey("k1"));
            assert.isTrue(yield* records.markRotated("k1", at(10), at(1_000)));
            assert.isFalse(yield* records.markRotated("k1", at(20), at(9_000)));
            const row = yield* stored("k1");
            assert.strictEqual(millisOf(row.rotatedAt), 10);
            assert.strictEqual(millisOf(row.retiresAt), 1_000);
            assert.isTrue(Option.isNone(yield* records.findCurrent()));
            assert.isFalse(yield* records.markRotated("nope", at(10), at(1_000)));
            // The slot is free: the next current key is accepted.
            yield* records.create(localKey("k2"));
            assert.strictEqual(yield* currentKid, "k2");
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent rotations of the current key: exactly one answers true, and its grace period is stored",
          run: Effect.gen(function* () {
            const records = yield* SigningKeyRecords.SigningKeyRecords;
            yield* records.create(localKey("k1"));
            let next = 0;
            const results = yield* RecordsContract.race(
              Effect.suspend(() => {
                next += 1;
                const retiresAt = 1_000 + next;
                return Effect.map(records.markRotated("k1", at(10), at(retiresAt)), (won) => ({
                  retiresAt,
                  won,
                }));
              }),
            ).pipe(fineGrained);
            const winners = results.filter((result) => result.won);
            assert.strictEqual(winners.length, 1);
            assert.strictEqual(millisOf((yield* stored("k1")).retiresAt), winners[0]?.retiresAt);
          }),
        },
      ],
    },
    retire: {
      atomic: [
        {
          name: "shortens a rotated key's grace period, never lengthens it, never touches the current key",
          run: Effect.gen(function* () {
            const records = yield* SigningKeyRecords.SigningKeyRecords;
            yield* records.create({ ...publicKey("old"), ...rotated(0, 5_000) });
            yield* records.create(localKey("k1"));
            assert.isFalse(yield* records.retire("old", at(6_000)));
            assert.isFalse(yield* records.retire("old", at(5_000)));
            assert.isTrue(yield* records.retire("old", at(100)));
            assert.strictEqual(millisOf((yield* stored("old")).retiresAt), 100);
            assert.isFalse(yield* records.retire("k1", at(100)));
            assert.isTrue(Option.isNone((yield* stored("k1")).retiresAt));
            assert.isFalse(yield* records.retire("nope", at(100)));
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent retirements to different instants: the earliest is stored and answered true",
          run: Effect.gen(function* () {
            const records = yield* SigningKeyRecords.SigningKeyRecords;
            yield* records.create({ ...publicKey("old"), ...rotated(0, 9_000) });
            let next = 0;
            const results = yield* RecordsContract.race(
              Effect.suspend(() => {
                next += 1;
                const retiresAt = 1_000 * next;
                return Effect.map(records.retire("old", at(retiresAt)), (won) => ({
                  retiresAt,
                  won,
                }));
              }),
            ).pipe(fineGrained);
            assert.strictEqual(millisOf((yield* stored("old")).retiresAt), 1_000);
            assert.isTrue(results.some((result) => result.retiresAt === 1_000 && result.won));
          }),
        },
      ],
    },
  },
  sql: [
    {
      name: "the migrations create the single-current unique index and the active-key index (JJS-004, SSMS-001)",
      run: Effect.gen(function* () {
        const single = yield* indexDefinition("jwt_signing_key_single_current");
        assert.strictEqual(single.length, 1);
        assert.include(single[0] ?? "", "UNIQUE");
        assert.strictEqual((yield* indexDefinition("jwt_signing_key_active_idx")).length, 1);
      }),
    },
    {
      name: "a store outage on create is StoreUnavailable naming SigningKeyRecords.create",
      run: Effect.gen(function* () {
        yield* TestSql.injectFailure({
          name: "jwt_signing_key_fail_insert",
          table: "jwt_signing_key",
          event: "INSERT",
        });
        const records = yield* SigningKeyRecords.SigningKeyRecords;
        const failure = yield* Effect.flip(records.create(localKey("k1")));
        assert.strictEqual(failure._tag, "StoreUnavailable");
        if (failure._tag === "StoreUnavailable") {
          assert.strictEqual(failure.operation, "SigningKeyRecords.create");
        }
      }),
    },
  ],
});
