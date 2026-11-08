// Plan 25 ticket 19 (ADR-EA-041 decision 9): `DeviceClientRecords`' contract, its first adapter-level suite (F11),
// run on memory and SQL (Postgres under `pnpm test:pg`) from `Contract.test.ts`, a fresh store per case. BEH-EA-305:
// a runtime-registered device client is stored once (`registerClient` answers `ClientExists` on `false`), listed
// oldest first, and revoked once (`revokeClient` answers whether a live client was revoked).
import { RecordsContract, TestSql } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";
import * as DeviceClientRecords from "../../src/DeviceClientRecords.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);

/** A client as `DeviceAuthorization.registerClient` would build it. */
const client = (
  clientId: string,
  patch: Partial<DeviceClientRecords.DeviceClientRecord> = {},
): DeviceClientRecords.DeviceClientRecord => ({
  clientId,
  name: `client ${clientId}`,
  scopes: ["repo"],
  createdAt: at(1_000),
  revokedAt: Option.none(),
  ...patch,
});

const millisOf = (value: Option.Option<DateTime.Utc>) =>
  Option.getOrNull(Option.map(value, DateTime.toEpochMillis));

/** A record with its instants as epoch millis, comparable with `deepStrictEqual` on every adapter. */
const plain = (record: DeviceClientRecords.DeviceClientRecord) => ({
  ...record,
  createdAt: DateTime.toEpochMillis(record.createdAt),
  revokedAt: millisOf(record.revokedAt),
});

const stored = (clientId: string) =>
  Effect.flatMap(DeviceClientRecords.DeviceClientRecords, (records) =>
    Effect.map(records.findById(clientId), Option.getOrThrow),
  );

/**
 * Racing fibers yield to the scheduler every few steps, so they interleave between a read and a write.
 * (Effect 4.1.2 stalls with a budget below 4.)
 */
const fineGrained = Effect.provideService(Scheduler.MaxOpsBeforeYield, 4);

export const deviceClientRecords = RecordsContract.suite(DeviceClientRecords.DeviceClientRecords, {
  operations: {
    insert: {
      atomic: [
        {
          name: "a stored client reads back field for field",
          run: Effect.gen(function* () {
            const records = yield* DeviceClientRecords.DeviceClientRecords;
            const record = client("cli", { scopes: ["repo", "read:user"] });
            assert.isTrue(yield* records.insert(record));
            assert.deepStrictEqual(plain(yield* stored("cli")), plain(record));
            const revoked = client("old", { scopes: [], revokedAt: Option.some(at(2_000)) });
            assert.isTrue(yield* records.insert(revoked));
            assert.deepStrictEqual(plain(yield* stored("old")), plain(revoked));
          }),
        },
        {
          name: "a taken client id is refused (false) and keeps the first, revoked or not",
          run: Effect.gen(function* () {
            const records = yield* DeviceClientRecords.DeviceClientRecords;
            yield* records.insert(client("cli"));
            assert.isFalse(yield* records.insert(client("cli", { name: "impostor" })));
            assert.strictEqual((yield* stored("cli")).name, "client cli");
            yield* records.revoke("cli", at(2_000));
            assert.isFalse(yield* records.insert(client("cli", { name: "impostor" })));
            assert.strictEqual(millisOf((yield* stored("cli")).revokedAt), 2_000);
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent registrations of one client id: exactly one is stored",
          run: Effect.gen(function* () {
            const records = yield* DeviceClientRecords.DeviceClientRecords;
            let next = 0;
            const results = yield* RecordsContract.race(
              Effect.suspend(() => {
                next += 1;
                const name = `name ${next}`;
                return Effect.map(records.insert(client("cli", { name })), (won) => ({
                  name,
                  won,
                }));
              }),
            ).pipe(fineGrained);
            const winners = results.filter((result) => result.won);
            assert.strictEqual(winners.length, 1);
            assert.strictEqual((yield* stored("cli")).name, winners[0]?.name);
            assert.strictEqual((yield* records.list).length, 1);
          }),
        },
      ],
    },
    findById: {
      read: [
        {
          name: "an unknown client id is None",
          run: Effect.gen(function* () {
            const records = yield* DeviceClientRecords.DeviceClientRecords;
            yield* records.insert(client("cli"));
            assert.isTrue(Option.isNone(yield* records.findById("nope")));
          }),
        },
      ],
    },
    list: {
      read: [
        {
          name: "every client, revoked ones too, oldest first, equal times by client id ascending",
          run: Effect.gen(function* () {
            const records = yield* DeviceClientRecords.DeviceClientRecords;
            assert.deepStrictEqual(yield* records.list, []);
            yield* records.insert(client("c", { createdAt: at(2_000) }));
            yield* records.insert(client("b", { createdAt: at(2_000) }));
            yield* records.insert(client("d", { createdAt: at(3_000) }));
            yield* records.insert(
              client("a", { createdAt: at(1_000), revokedAt: Option.some(at(4_000)) }),
            );
            assert.deepStrictEqual(
              (yield* records.list).map((record) => record.clientId),
              ["a", "b", "c", "d"],
            );
          }),
        },
      ],
    },
    revoke: {
      atomic: [
        {
          name: "revokes a live client once: a second revocation answers false and keeps the first time",
          run: Effect.gen(function* () {
            const records = yield* DeviceClientRecords.DeviceClientRecords;
            yield* records.insert(client("cli"));
            yield* records.insert(client("other"));
            assert.isTrue(yield* records.revoke("cli", at(5_000)));
            assert.isFalse(yield* records.revoke("cli", at(6_000)));
            assert.strictEqual(millisOf((yield* stored("cli")).revokedAt), 5_000);
            assert.isTrue(Option.isNone((yield* stored("other")).revokedAt));
            assert.isFalse(yield* records.revoke("nope", at(5_000)));
            assert.isTrue(Option.isNone(yield* records.findById("nope")));
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent revocations: exactly one answers true, and its time is the one stored",
          run: Effect.gen(function* () {
            const records = yield* DeviceClientRecords.DeviceClientRecords;
            yield* records.insert(client("cli"));
            let next = 0;
            const results = yield* RecordsContract.race(
              Effect.suspend(() => {
                next += 1;
                const millis = 5_000 + next;
                return Effect.map(records.revoke("cli", at(millis)), (won) => ({ millis, won }));
              }),
            ).pipe(fineGrained);
            const winners = results.filter((result) => result.won);
            assert.strictEqual(winners.length, 1);
            assert.strictEqual(millisOf((yield* stored("cli")).revokedAt), winners[0]?.millis);
          }),
        },
      ],
    },
  },
  sql: [
    {
      name: "a store outage on insert is StoreUnavailable naming DeviceClientRecords.insert",
      run: Effect.gen(function* () {
        yield* TestSql.injectFailure({
          name: "device_client_fail_insert",
          table: "device_authorization_client",
          event: "INSERT",
        });
        const records = yield* DeviceClientRecords.DeviceClientRecords;
        const failure = yield* Effect.flip(records.insert(client("cli")));
        assert.strictEqual(failure._tag, "StoreUnavailable");
        assert.strictEqual(failure.operation, "DeviceClientRecords.insert");
      }),
    },
  ],
});
