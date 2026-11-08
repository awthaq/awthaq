// Plan 25 ticket 17 (ADR-EA-041 decision 9): `ApiKeyRecords`' contract, its first adapter-level suite (F11), run
// on memory and SQL (Postgres under `pnpm test:pg`) from `Contract.test.ts`, a fresh store per case. MOD-EA-007 /
// ADR-EA-022: `rotate` stores a successor only while its predecessor is live, and caps the predecessor's expiry in
// the same step (F6); `revoke` answers whether this call revoked the key, so exactly one of any number of
// concurrent revocations does (F10). A reused id is a defect on both adapters.
import { Users } from "@awthaq/core";
import { RecordsContract, TestSql } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";
import * as ApiKeyRecords from "../../src/ApiKeyRecords.ts";

const owner = Users.UserId("owner-1");
const other = Users.UserId("owner-2");

const at = (millis: number) => DateTime.makeUnsafe(millis);

/** A key as `ApiKey.mint` would build it, live and never used. */
const key = (
  id: string,
  patch: Partial<ApiKeyRecords.ApiKeyRecord> = {},
): ApiKeyRecords.ApiKeyRecord => ({
  id,
  ownerId: owner,
  name: `key ${id}`,
  start: `ak_${id}`,
  secretHash: `hash-${id}`,
  scopes: ["reports:read"],
  createdAt: at(1_000),
  expiresAt: Option.none(),
  revokedAt: Option.none(),
  lastUsedAt: Option.none(),
  rotatedFrom: Option.none(),
  ...patch,
});

const millisOf = (value: Option.Option<DateTime.Utc>) =>
  Option.getOrNull(Option.map(value, DateTime.toEpochMillis));

/** A record with its instants as epoch millis, comparable with `deepStrictEqual` on every adapter. */
const plain = (record: ApiKeyRecords.ApiKeyRecord) => ({
  ...record,
  createdAt: DateTime.toEpochMillis(record.createdAt),
  expiresAt: millisOf(record.expiresAt),
  revokedAt: millisOf(record.revokedAt),
  lastUsedAt: millisOf(record.lastUsedAt),
  rotatedFrom: Option.getOrNull(record.rotatedFrom),
});

const stored = (id: string) =>
  Effect.flatMap(ApiKeyRecords.ApiKeyRecords, (records) =>
    Effect.map(records.findById(id), Option.getOrThrow),
  );

const absent = (id: string) =>
  Effect.flatMap(ApiKeyRecords.ApiKeyRecords, (records) =>
    Effect.map(records.findById(id), Option.isNone),
  );

/**
 * Racing fibers yield to the scheduler every few steps, so they interleave between the statements of one write.
 * (Effect 4.1.2 stalls with a budget below 4.)
 */
const fineGrained = Effect.provideService(Scheduler.MaxOpsBeforeYield, 4);

/** Races `writers` and returns every outcome. */
const raced = <A, E, R>(writers: ReadonlyArray<Effect.Effect<A, E, R>>) =>
  Effect.all(
    writers.map((writer) => Effect.exit(writer)),
    { concurrency: "unbounded" },
  ).pipe(fineGrained);

const many = <A>(make: (n: number) => A) =>
  Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) => make(n));

const NOW = at(10_000);
const GRACE = at(20_000);

const rotation = (predecessorId: string, successorId: string, graceUntil = GRACE) => ({
  predecessorId,
  successor: key(successorId, { createdAt: NOW, rotatedFrom: Option.some(predecessorId) }),
  graceUntil,
  now: NOW,
});

export const apiKeyRecords = RecordsContract.suite(ApiKeyRecords.ApiKeyRecords, {
  operations: {
    insert: {
      write: [
        {
          name: "a stored key reads back field for field",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            const record = key("a", {
              scopes: ["a:b", "c:d"],
              expiresAt: Option.some(at(50_000)),
              rotatedFrom: Option.some("z"),
            });
            yield* records.insert(record);
            assert.deepStrictEqual(plain(yield* stored("a")), plain(record));
          }),
        },
        {
          name: "a second insert of an existing id is a defect and keeps the first",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            yield* records.insert(key("a"));
            const exit = yield* Effect.exit(records.insert(key("a", { name: "impostor" })));
            assert.isTrue(Exit.hasDies(exit));
            assert.strictEqual((yield* stored("a")).name, "key a");
          }),
        },
      ],
    },
    findById: {
      read: [
        {
          name: "an unknown id is None",
          run: Effect.gen(function* () {
            assert.isTrue(yield* absent("nope"));
          }),
        },
      ],
    },
    listByOwner: {
      read: [
        {
          name: "the owner's keys, newest first, equal times by id descending; nobody else's",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            yield* records.insert(key("a", { createdAt: at(1_000) }));
            yield* records.insert(key("b", { createdAt: at(2_000) }));
            yield* records.insert(key("c", { createdAt: at(2_000) }));
            yield* records.insert(key("d", { ownerId: other, createdAt: at(3_000) }));
            const listed = yield* records.listByOwner(owner);
            assert.deepStrictEqual(
              listed.map((record) => record.id),
              ["c", "b", "a"],
            );
            assert.deepStrictEqual(yield* records.listByOwner(Users.UserId("nobody")), []);
          }),
        },
      ],
    },
    revoke: {
      atomic: [
        {
          name: "true for the call that revokes, false after; the first revocation time is kept",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            yield* records.insert(key("a"));
            assert.isTrue(yield* records.revoke("a", at(5_000)));
            assert.isFalse(yield* records.revoke("a", at(6_000)));
            assert.strictEqual(millisOf((yield* stored("a")).revokedAt), 5_000);
          }),
        },
        {
          name: "an unknown id answers false and stores nothing",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            assert.isFalse(yield* records.revoke("nope", at(5_000)));
            assert.isTrue(yield* absent("nope"));
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent revokes: exactly one true, and its time is the one kept",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            yield* records.insert(key("a"));
            const outcomes = yield* raced(many((n) => records.revoke("a", at(5_000 + n))));
            const winners = outcomes.flatMap((exit, n) =>
              Exit.isSuccess(exit) && exit.value ? [n] : [],
            );
            assert.isTrue(outcomes.every(Exit.isSuccess));
            assert.strictEqual(winners.length, 1);
            assert.strictEqual(
              millisOf((yield* stored("a")).revokedAt),
              5_000 + (winners[0] ?? -1),
            );
          }),
        },
      ],
    },
    rotate: {
      atomic: [
        {
          name: "a live key: the successor is stored and the predecessor now expires at graceUntil",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            yield* records.insert(key("a"));
            const input = rotation("a", "b");
            assert.strictEqual(yield* records.rotate(input), "rotated");
            assert.deepStrictEqual(plain(yield* stored("b")), plain(input.successor));
            assert.strictEqual(millisOf((yield* stored("a")).expiresAt), 20_000);
            assert.isTrue(Option.isNone((yield* stored("a")).revokedAt));
          }),
        },
        {
          name: "never lengthens: a predecessor already expiring before graceUntil keeps its expiry",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            yield* records.insert(key("a", { expiresAt: Option.some(at(15_000)) }));
            assert.strictEqual(yield* records.rotate(rotation("a", "b")), "rotated");
            assert.strictEqual(millisOf((yield* stored("a")).expiresAt), 15_000);
          }),
        },
        {
          name: "a revoked predecessor is notLive, and no successor is stored",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            yield* records.insert(key("a", { revokedAt: Option.some(at(5_000)) }));
            assert.strictEqual(yield* records.rotate(rotation("a", "b")), "notLive");
            assert.isTrue(yield* absent("b"));
            assert.isTrue(Option.isNone((yield* stored("a")).expiresAt));
          }),
        },
        {
          name: "an expired predecessor (expiry at or before now) is notLive, and no successor is stored",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            yield* records.insert(key("a", { expiresAt: Option.some(NOW) }));
            assert.strictEqual(yield* records.rotate(rotation("a", "b")), "notLive");
            assert.isTrue(yield* absent("b"));
            assert.strictEqual(millisOf((yield* stored("a")).expiresAt), 10_000);
          }),
        },
        {
          name: "an unknown predecessor is notLive, and nothing is stored",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            assert.strictEqual(yield* records.rotate(rotation("nope", "b")), "notLive");
            assert.isTrue(yield* absent("b"));
          }),
        },
        {
          name: "a successor whose id exists is a defect, and the predecessor's expiry is untouched",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            yield* records.insert(key("a"));
            yield* records.insert(key("b"));
            const exit = yield* Effect.exit(records.rotate(rotation("a", "b")));
            assert.isTrue(Exit.hasDies(exit));
            assert.isTrue(Option.isNone((yield* stored("a")).expiresAt));
            assert.strictEqual(DateTime.toEpochMillis((yield* stored("b")).createdAt), 1_000);
          }),
        },
      ],
      race: [
        {
          name: "rotate racing revoke never leaves a live successor of a revoked key: a revoke landing after the caller's liveness read wins",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            yield* records.insert(key("a"));
            // The caller (ApiKey.rotate) has read the key live; the revoke lands before it rotates.
            assert.isTrue(Option.isSome(yield* records.findById("a")));
            assert.isTrue(yield* records.revoke("a", at(9_000)));
            assert.strictEqual(yield* records.rotate(rotation("a", "b")), "notLive");
            assert.isTrue(yield* absent("b"));
          }),
        },
        {
          name: "rotate racing revoke never leaves a live successor of a revoked key: 8 zero-grace rotations and a revoke, at most one successor, each answer matching what is stored",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            yield* records.insert(key("a"));
            const [revoked, rotations] = yield* Effect.all(
              [
                records.revoke("a", at(9_000)),
                raced(many((n) => records.rotate(rotation("a", `s${n}`, NOW)))),
              ],
              { concurrency: "unbounded" },
            ).pipe(fineGrained);
            assert.isTrue(revoked);
            let successors = 0;
            for (const [n, exit] of rotations.entries()) {
              assert.isTrue(Exit.isSuccess(exit));
              const present = !(yield* absent(`s${n}`));
              assert.strictEqual(present, Exit.isSuccess(exit) && exit.value === "rotated");
              if (present) successors++;
            }
            // A zero grace ends the predecessor at `now`: one rotation can win, never two.
            assert.isAtMost(successors, 1);
            assert.isTrue(Option.isSome((yield* stored("a")).revokedAt));
          }),
        },
        {
          name: "8 concurrent zero-grace rotations of one key store exactly one successor",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            yield* records.insert(key("a"));
            const outcomes = yield* raced(many((n) => records.rotate(rotation("a", `s${n}`, NOW))));
            const rotated = outcomes.filter(
              (exit) => Exit.isSuccess(exit) && exit.value === "rotated",
            );
            assert.isTrue(outcomes.every(Exit.isSuccess));
            assert.strictEqual(rotated.length, 1);
            assert.strictEqual(
              (yield* records.listByOwner(owner)).filter((record) => record.id !== "a").length,
              1,
            );
          }),
        },
      ],
    },
    touch: {
      write: [
        {
          name: "sets lastUsedAt; an unknown id is a no-op",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            yield* records.insert(key("a"));
            yield* records.touch("a", at(7_000));
            assert.strictEqual(millisOf((yield* stored("a")).lastUsedAt), 7_000);
            yield* records.touch("nope", at(7_000));
            assert.isTrue(yield* absent("nope"));
          }),
        },
      ],
    },
    deleteByOwner: {
      write: [
        {
          name: "removes every key of the owner, revoked or not, and nobody else's; idempotent",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyRecords.ApiKeyRecords;
            yield* records.insert(key("a"));
            yield* records.insert(key("b", { revokedAt: Option.some(at(2_000)) }));
            yield* records.insert(key("c", { ownerId: other }));
            yield* records.deleteByOwner(owner);
            yield* records.deleteByOwner(owner);
            assert.deepStrictEqual(yield* records.listByOwner(owner), []);
            assert.deepStrictEqual(
              (yield* records.listByOwner(other)).map((record) => record.id),
              ["c"],
            );
          }),
        },
      ],
    },
  },
  sql: [
    {
      name: "plan 05: a store outage on insert is StoreUnavailable naming ApiKeyRecords.insert",
      run: Effect.gen(function* () {
        yield* TestSql.injectFailure({
          name: "apikey_fail_insert",
          table: "apikey_key",
          event: "INSERT",
        });
        const records = yield* ApiKeyRecords.ApiKeyRecords;
        const failure = yield* Effect.flip(records.insert(key("a")));
        assert.strictEqual(failure._tag, "StoreUnavailable");
        assert.strictEqual(failure.operation, "ApiKeyRecords.insert");
      }),
    },
    {
      name: "F6: a successor insert that fails rolls the predecessor's grace cap back",
      run: Effect.gen(function* () {
        const records = yield* ApiKeyRecords.ApiKeyRecords;
        yield* records.insert(key("a"));
        yield* TestSql.injectFailure({
          name: "apikey_fail_rotate_insert",
          table: "apikey_key",
          event: "INSERT",
        });
        const failure = yield* Effect.flip(records.rotate(rotation("a", "b")));
        assert.strictEqual(failure.operation, "ApiKeyRecords.rotate");
        assert.isTrue(Option.isNone((yield* stored("a")).expiresAt));
        assert.isTrue(yield* absent("b"));
      }),
    },
  ],
});
