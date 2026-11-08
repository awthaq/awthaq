// Plan 25 ticket 19 (ADR-EA-041 decision 9): `DeviceGrantRecords`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`, a fresh store per case. BEH-EA-299 to 304 and 306, the model's design
// constraints 1 to 4: every state change is one conditional statement, so of any number of racing claims, decisions
// or redemptions exactly one wins, on every backend (before this suite the compare-and-swap cases ran on memory only,
// in `Plugin.test.ts`). An insert refuses a taken user-code hash, device-code hash or id on both adapters. Plan 24: an
// insert outage names `DeviceGrantRecords.insert`, not a column.
import { Users } from "@awthaq/core";
import { RecordsContract, TestSql } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";
import * as DeviceGrantRecords from "../../src/DeviceGrantRecords.ts";

const owner = Users.UserId("owner");
const rival = Users.UserId("rival");

const at = (millis: number) => DateTime.makeUnsafe(millis);

/** The instant every case decides at: before any grant's `expiresAt` unless it says otherwise. */
const NOW = at(1_000_000);

/** A pending, unclaimed grant as `DeviceAuthorization.requestCode` would insert it. */
const grant = (
  id: string,
  patch: Partial<DeviceGrantRecords.DeviceGrantRecord> = {},
): DeviceGrantRecords.DeviceGrantRecord => ({
  id,
  deviceCodeHash: `device-${id}`,
  userCodeHash: `user-${id}`,
  clientId: "cli",
  scopes: [],
  status: "pending",
  userId: Option.none(),
  amr: [],
  pollInterval: 5,
  createdAt: at(900_000),
  expiresAt: at(1_900_000),
  lastPolledAt: Option.none(),
  ...patch,
});

const millisOf = (value: Option.Option<DateTime.Utc>) =>
  Option.getOrNull(Option.map(value, DateTime.toEpochMillis));

/** A record with its instants as epoch millis, comparable with `deepStrictEqual` on every adapter. */
const plain = (record: DeviceGrantRecords.DeviceGrantRecord) => ({
  ...record,
  userId: Option.getOrNull(record.userId),
  createdAt: DateTime.toEpochMillis(record.createdAt),
  expiresAt: DateTime.toEpochMillis(record.expiresAt),
  lastPolledAt: millisOf(record.lastPolledAt),
});

const stored = (id: string) =>
  Effect.flatMap(DeviceGrantRecords.DeviceGrantRecords, (records) =>
    Effect.map(records.findByDeviceHash(`device-${id}`), Option.getOrThrow),
  );

const absent = (id: string) =>
  Effect.flatMap(DeviceGrantRecords.DeviceGrantRecords, (records) =>
    Effect.map(records.findByDeviceHash(`device-${id}`), Option.isNone),
  );

/** Inserts `id` claimed by `owner` and, with `status`, decided. */
const arranged = (id: string, status?: "approved" | "denied") =>
  Effect.gen(function* () {
    const records = yield* DeviceGrantRecords.DeviceGrantRecords;
    yield* records.insert(grant(id));
    yield* records.claim(id, owner);
    if (status !== undefined) {
      yield* records.decide({ id, userId: owner, status, amr: ["pwd"], now: NOW });
    }
  });

/**
 * Racing fibers yield to the scheduler every few steps, so they interleave between a read and a write.
 * (Effect 4.1.2 stalls with a budget below 4.)
 */
const fineGrained = Effect.provideService(Scheduler.MaxOpsBeforeYield, 4);

export const deviceGrantRecords = RecordsContract.suite(DeviceGrantRecords.DeviceGrantRecords, {
  operations: {
    insert: {
      atomic: [
        {
          name: "a stored grant reads back field for field, by either hash",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            const record = grant("g1", {
              scopes: ["repo", "read:user"],
              userId: Option.some(owner),
              amr: ["pwd", "otp"],
              lastPolledAt: Option.some(at(950_000)),
            });
            assert.isTrue(yield* records.insert(record));
            assert.deepStrictEqual(plain(yield* stored("g1")), plain(record));
            const byUser = Option.getOrThrow(yield* records.findByUserHash("user-g1"));
            assert.deepStrictEqual(plain(byUser), plain(record));
          }),
        },
        {
          name: "a taken user-code hash, device-code hash or id is refused (false) and keeps the first row",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            assert.isTrue(yield* records.insert(grant("g1")));
            // A user-code collision: the caller draws another code.
            assert.isFalse(yield* records.insert(grant("g2", { userCodeHash: "user-g1" })));
            assert.isFalse(yield* records.insert(grant("g3", { deviceCodeHash: "device-g1" })));
            assert.isFalse(
              yield* records.insert(
                grant("g1", { deviceCodeHash: "device-other", userCodeHash: "user-other" }),
              ),
            );
            assert.isTrue(Option.isNone(yield* records.findByDeviceHash("device-other")));
            assert.isTrue(yield* absent("g2"));
            assert.strictEqual((yield* stored("g1")).userCodeHash, "user-g1");
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent inserts of one user-code hash: exactly one is stored",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            let next = 0;
            const results = yield* RecordsContract.race(
              Effect.suspend(() => {
                next += 1;
                return records.insert(grant(`g${next}`, { userCodeHash: "user-shared" }));
              }),
            ).pipe(fineGrained);
            assert.strictEqual(results.filter((inserted) => inserted).length, 1);
            assert.isTrue(Option.isSome(yield* records.findByUserHash("user-shared")));
          }),
        },
      ],
    },
    findByDeviceHash: {
      read: [
        {
          name: "an unknown device-code hash is None",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            yield* records.insert(grant("g1"));
            assert.isTrue(Option.isNone(yield* records.findByDeviceHash("nope")));
            assert.isTrue(Option.isNone(yield* records.findByDeviceHash("user-g1")));
          }),
        },
      ],
    },
    findByUserHash: {
      read: [
        {
          name: "an unknown user-code hash is None",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            yield* records.insert(grant("g1"));
            assert.isTrue(Option.isNone(yield* records.findByUserHash("nope")));
            assert.isTrue(Option.isNone(yield* records.findByUserHash("device-g1")));
          }),
        },
      ],
    },
    claim: {
      atomic: [
        {
          name: "the first claimer wins once; a rival's claim, an unknown id and a decided grant are refused",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            yield* records.insert(grant("g1"));
            assert.isTrue(yield* records.claim("g1", owner));
            assert.isFalse(yield* records.claim("g1", rival));
            assert.isFalse(yield* records.claim("g1", owner), "a claim is taken once");
            assert.deepStrictEqual((yield* stored("g1")).userId, Option.some(owner));
            assert.isFalse(yield* records.claim("nope", owner));
            // A grant inserted already decided (no claimer) is not claimable: only `pending` is.
            yield* records.insert(grant("g2", { status: "denied" }));
            assert.isFalse(yield* records.claim("g2", owner));
            assert.isTrue(Option.isNone((yield* stored("g2")).userId));
          }),
        },
      ],
      race: [
        {
          name: "8 sessions opening the page together: exactly one claims, and the row names it",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            yield* records.insert(grant("g1"));
            let next = 0;
            const results = yield* RecordsContract.race(
              Effect.suspend(() => {
                next += 1;
                const userId = Users.UserId(`user-${next}`);
                return Effect.map(records.claim("g1", userId), (won) => ({ userId, won }));
              }),
            ).pipe(fineGrained);
            const winners = results.filter((result) => result.won);
            assert.strictEqual(winners.length, 1);
            assert.deepStrictEqual((yield* stored("g1")).userId, Option.some(winners[0]?.userId));
          }),
        },
      ],
    },
    decide: {
      atomic: [
        {
          name: "only the claimer, only once, only before expiresAt; the decision stores the status and amr",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            yield* records.insert(grant("unclaimed"));
            assert.isFalse(
              yield* records.decide({
                id: "unclaimed",
                userId: owner,
                status: "approved",
                amr: [],
                now: NOW,
              }),
              "an unclaimed grant is not decided",
            );
            yield* arranged("g1");
            assert.isFalse(
              yield* records.decide({
                id: "g1",
                userId: rival,
                status: "approved",
                amr: [],
                now: NOW,
              }),
            );
            // An expired grant cannot be decided, even by its claimer; `expiresAt` itself is already too late.
            for (const now of [at(1_900_000), at(1_960_000)]) {
              assert.isFalse(
                yield* records.decide({
                  id: "g1",
                  userId: owner,
                  status: "approved",
                  amr: [],
                  now,
                }),
              );
            }
            assert.isTrue(
              yield* records.decide({
                id: "g1",
                userId: owner,
                status: "approved",
                amr: ["pwd", "mfa"],
                now: NOW,
              }),
            );
            assert.isFalse(
              yield* records.decide({
                id: "g1",
                userId: owner,
                status: "denied",
                amr: [],
                now: NOW,
              }),
              "a terminal state never returns to pending",
            );
            const decided = yield* stored("g1");
            assert.strictEqual(decided.status, "approved");
            assert.deepStrictEqual(decided.amr, ["pwd", "mfa"]);
            assert.isFalse(
              yield* records.decide({
                id: "nope",
                userId: owner,
                status: "denied",
                amr: [],
                now: NOW,
              }),
            );
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent approvals and denials by the claimer: exactly one decides, and the row holds it",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            yield* arranged("g1");
            let next = 0;
            const results = yield* RecordsContract.race(
              Effect.suspend(() => {
                next += 1;
                const status = next % 2 === 0 ? "approved" : "denied";
                return Effect.map(
                  records.decide({ id: "g1", userId: owner, status, amr: [], now: NOW }),
                  (won) => ({ status, won }),
                );
              }),
            ).pipe(fineGrained);
            const winners = results.filter((result) => result.won);
            assert.strictEqual(winners.length, 1);
            assert.strictEqual((yield* stored("g1")).status, winners[0]?.status);
          }),
        },
      ],
    },
    touchPoll: {
      write: [
        {
          name: "records the poll's time, the latest write winning; an unknown id is a no-op",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            yield* records.insert(grant("g1"));
            yield* records.touchPoll("g1", at(1_005_000));
            assert.strictEqual(millisOf((yield* stored("g1")).lastPolledAt), 1_005_000);
            yield* records.touchPoll("g1", at(1_010_000));
            assert.strictEqual(millisOf((yield* stored("g1")).lastPolledAt), 1_010_000);
            yield* records.touchPoll("nope", at(1_010_000));
            assert.isTrue(yield* absent("nope"));
          }),
        },
      ],
    },
    raiseInterval: {
      atomic: [
        {
          name: "adds the seconds to the row's interval; an unknown id is a no-op",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            yield* records.insert(grant("g1"));
            yield* records.raiseInterval("g1", 5);
            yield* records.raiseInterval("g1", 3);
            assert.strictEqual((yield* stored("g1")).pollInterval, 13);
            yield* records.raiseInterval("nope", 5);
            assert.isTrue(yield* absent("nope"));
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent slow_downs each count: the interval rises by 8 steps",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            yield* records.insert(grant("g1"));
            yield* RecordsContract.race(records.raiseInterval("g1", 5)).pipe(fineGrained);
            assert.strictEqual(
              (yield* stored("g1")).pollInterval,
              5 + 5 * RecordsContract.CONCURRENCY,
            );
          }),
        },
      ],
    },
    consume: {
      atomic: [
        {
          name: "only an approved grant, only for its claimer, handed back once and deleted",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            yield* arranged("pending");
            assert.isTrue(Option.isNone(yield* records.consume("pending", owner)));
            yield* arranged("denied", "denied");
            assert.isTrue(Option.isNone(yield* records.consume("denied", owner)));
            yield* arranged("g1", "approved");
            assert.isTrue(Option.isNone(yield* records.consume("g1", rival)));
            const consumed = Option.getOrThrow(yield* records.consume("g1", owner));
            assert.strictEqual(consumed.id, "g1");
            assert.strictEqual(consumed.status, "approved");
            assert.deepStrictEqual(consumed.amr, ["pwd"]);
            assert.deepStrictEqual(consumed.userId, Option.some(owner));
            assert.isTrue(yield* absent("g1"));
            assert.isTrue(Option.isNone(yield* records.consume("g1", owner)));
            assert.isFalse(yield* absent("pending"));
            assert.isFalse(yield* absent("denied"));
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent redemptions hand the approved row to exactly one caller",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            yield* arranged("g1", "approved");
            const results = yield* RecordsContract.race(records.consume("g1", owner)).pipe(
              fineGrained,
            );
            assert.strictEqual(results.filter(Option.isSome).length, 1);
            assert.isTrue(yield* absent("g1"));
          }),
        },
      ],
    },
    remove: {
      write: [
        {
          name: "deletes one row whatever its state, leaves the others; idempotent",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            yield* arranged("g1", "approved");
            yield* records.insert(grant("g2"));
            yield* records.remove("g1");
            yield* records.remove("g1");
            yield* records.remove("nope");
            assert.isTrue(yield* absent("g1"));
            assert.isFalse(yield* absent("g2"));
          }),
        },
      ],
    },
    purgeExpired: {
      write: [
        {
          name: "deletes every row expiring before the cutoff and answers how many; one expiring at it stays",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            yield* records.insert(grant("old", { expiresAt: at(1_000) }));
            yield* arranged("older");
            yield* records.insert(grant("edge", { expiresAt: at(2_000_000) }));
            yield* records.insert(grant("live", { expiresAt: at(3_000_000) }));
            // `older` (claimed, expiresAt 1_900_000) and `old` go; `edge` expires exactly at the cutoff.
            assert.strictEqual(yield* records.purgeExpired(at(2_000_000)), 2);
            assert.isTrue(yield* absent("old"));
            assert.isTrue(yield* absent("older"));
            assert.isFalse(yield* absent("edge"));
            assert.isFalse(yield* absent("live"));
            assert.strictEqual(yield* records.purgeExpired(at(2_000_000)), 0);
          }),
        },
      ],
    },
    listByUser: {
      read: [
        {
          name: "the rows the user claimed or decided, oldest first; nobody else's, no unclaimed one",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            yield* records.insert(grant("late", { createdAt: at(950_000) }));
            yield* records.claim("late", owner);
            yield* records.insert(grant("early", { createdAt: at(910_000) }));
            yield* records.claim("early", owner);
            yield* records.decide({
              id: "early",
              userId: owner,
              status: "denied",
              amr: [],
              now: NOW,
            });
            yield* records.insert(grant("theirs"));
            yield* records.claim("theirs", rival);
            yield* records.insert(grant("unclaimed"));
            assert.deepStrictEqual(
              (yield* records.listByUser(owner)).map((record) => record.id),
              ["early", "late"],
            );
            assert.deepStrictEqual(yield* records.listByUser(Users.UserId("nobody")), []);
          }),
        },
      ],
    },
    deleteByUser: {
      write: [
        {
          name: "erasure: removes every row the user claimed, whatever its state, and nobody else's; idempotent",
          run: Effect.gen(function* () {
            const records = yield* DeviceGrantRecords.DeviceGrantRecords;
            yield* arranged("g1");
            yield* arranged("g2", "approved");
            yield* records.insert(grant("theirs"));
            yield* records.claim("theirs", rival);
            yield* records.insert(grant("unclaimed"));
            yield* records.deleteByUser(owner);
            yield* records.deleteByUser(owner);
            assert.deepStrictEqual(yield* records.listByUser(owner), []);
            assert.isTrue(yield* absent("g1"));
            assert.isTrue(yield* absent("g2"));
            assert.isFalse(yield* absent("theirs"));
            assert.isFalse(yield* absent("unclaimed"));
          }),
        },
      ],
    },
  },
  sql: [
    {
      name: "plan 24: a store outage on insert is StoreUnavailable naming DeviceGrantRecords.insert",
      run: Effect.gen(function* () {
        yield* TestSql.injectFailure({
          name: "device_grant_fail_insert",
          table: "device_authorization_grant",
          event: "INSERT",
        });
        const records = yield* DeviceGrantRecords.DeviceGrantRecords;
        const failure = yield* Effect.flip(records.insert(grant("g1")));
        assert.strictEqual(failure._tag, "StoreUnavailable");
        assert.strictEqual(failure.operation, "DeviceGrantRecords.insert");
      }),
    },
  ],
});
