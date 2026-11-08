// Plan 25 ticket 17 (ADR-EA-041 decision 9): `ApiKeyClientRecords`' contract, its first adapter-level suite (F11),
// run on memory and SQL (Postgres under `pnpm test:pg`) from `Contract.test.ts`, a fresh store per case.
// MOD-EA-007 / ADR-EA-022: a client holds at most two valid secret hashes, and `rotateSecret`'s swap (current to
// previous, new to current) is one write. A reused client id is a defect on both adapters. Plan 24: an insert
// outage names `ApiKeyClientRecords.insert`, not a column.
import { Users } from "@awthaq/core";
import { RecordsContract, TestSql } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as ApiKeyClientRecords from "../../src/ApiKeyClientRecords.ts";

const owner = Users.UserId("owner-1");
const other = Users.UserId("owner-2");

const at = (millis: number) => DateTime.makeUnsafe(millis);

/** A client as `ApiKey.registerClient` would build it. */
const client = (
  clientId: string,
  patch: Partial<ApiKeyClientRecords.ApiKeyClientRecord> = {},
): ApiKeyClientRecords.ApiKeyClientRecord => ({
  clientId,
  ownerId: owner,
  name: `client ${clientId}`,
  scopes: ["invoices:read"],
  secretHash: `hash-${clientId}`,
  previousSecretHash: Option.none(),
  previousExpiresAt: Option.none(),
  createdAt: at(1_000),
  revokedAt: Option.none(),
  ...patch,
});

const millisOf = (value: Option.Option<DateTime.Utc>) =>
  Option.getOrNull(Option.map(value, DateTime.toEpochMillis));

/** A record with its instants as epoch millis, comparable with `deepStrictEqual` on every adapter. */
const plain = (record: ApiKeyClientRecords.ApiKeyClientRecord) => ({
  ...record,
  previousSecretHash: Option.getOrNull(record.previousSecretHash),
  previousExpiresAt: millisOf(record.previousExpiresAt),
  createdAt: DateTime.toEpochMillis(record.createdAt),
  revokedAt: millisOf(record.revokedAt),
});

const stored = (clientId: string) =>
  Effect.flatMap(ApiKeyClientRecords.ApiKeyClientRecords, (records) =>
    Effect.map(records.findById(clientId), Option.getOrThrow),
  );

const absent = (clientId: string) =>
  Effect.flatMap(ApiKeyClientRecords.ApiKeyClientRecords, (records) =>
    Effect.map(records.findById(clientId), Option.isNone),
  );

export const apiKeyClientRecords = RecordsContract.suite(ApiKeyClientRecords.ApiKeyClientRecords, {
  operations: {
    insert: {
      write: [
        {
          name: "a stored client reads back field for field",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyClientRecords.ApiKeyClientRecords;
            const record = client("a", { scopes: ["a:b", "c:d"] });
            yield* records.insert(record);
            assert.deepStrictEqual(plain(yield* stored("a")), plain(record));
          }),
        },
        {
          name: "a second insert of an existing client id is a defect and keeps the first",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyClientRecords.ApiKeyClientRecords;
            yield* records.insert(client("a"));
            const exit = yield* Effect.exit(records.insert(client("a", { name: "impostor" })));
            assert.isTrue(Exit.hasDies(exit));
            assert.strictEqual((yield* stored("a")).name, "client a");
          }),
        },
      ],
    },
    findById: {
      read: [
        {
          name: "an unknown client id is None",
          run: Effect.gen(function* () {
            assert.isTrue(yield* absent("nope"));
          }),
        },
      ],
    },
    listByOwner: {
      read: [
        {
          name: "the owner's clients, newest first, equal times by client id descending; nobody else's",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyClientRecords.ApiKeyClientRecords;
            yield* records.insert(client("a", { createdAt: at(1_000) }));
            yield* records.insert(client("b", { createdAt: at(2_000) }));
            yield* records.insert(client("c", { createdAt: at(2_000) }));
            yield* records.insert(client("d", { ownerId: other, createdAt: at(3_000) }));
            assert.deepStrictEqual(
              (yield* records.listByOwner(owner)).map((record) => record.clientId),
              ["c", "b", "a"],
            );
            assert.deepStrictEqual(yield* records.listByOwner(Users.UserId("nobody")), []);
          }),
        },
      ],
    },
    revoke: {
      write: [
        {
          name: "sets revokedAt once: a second revocation keeps the first time; an unknown id is a no-op",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyClientRecords.ApiKeyClientRecords;
            yield* records.insert(client("a"));
            yield* records.revoke("a", at(5_000));
            yield* records.revoke("a", at(6_000));
            assert.strictEqual(millisOf((yield* stored("a")).revokedAt), 5_000);
            yield* records.revoke("nope", at(5_000));
            assert.isTrue(yield* absent("nope"));
          }),
        },
      ],
    },
    rotateSecret: {
      write: [
        {
          name: "the current hash becomes the previous one until previousExpiresAt; the new one is current",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyClientRecords.ApiKeyClientRecords;
            yield* records.insert(client("a"));
            yield* records.rotateSecret({
              clientId: "a",
              secretHash: "h1",
              previousExpiresAt: at(9_000),
            });
            const rotated = yield* stored("a");
            assert.strictEqual(rotated.secretHash, "h1");
            assert.deepStrictEqual(rotated.previousSecretHash, Option.some("hash-a"));
            assert.strictEqual(millisOf(rotated.previousExpiresAt), 9_000);
          }),
        },
        {
          name: "at most two hashes: a second rotation retires the first; an unknown id is a no-op",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyClientRecords.ApiKeyClientRecords;
            yield* records.insert(client("a"));
            yield* records.rotateSecret({
              clientId: "a",
              secretHash: "h1",
              previousExpiresAt: at(9_000),
            });
            yield* records.rotateSecret({
              clientId: "a",
              secretHash: "h2",
              previousExpiresAt: at(12_000),
            });
            const rotated = yield* stored("a");
            assert.strictEqual(rotated.secretHash, "h2");
            assert.deepStrictEqual(rotated.previousSecretHash, Option.some("h1"));
            assert.strictEqual(millisOf(rotated.previousExpiresAt), 12_000);
            yield* records.rotateSecret({
              clientId: "nope",
              secretHash: "h3",
              previousExpiresAt: at(12_000),
            });
            assert.isTrue(yield* absent("nope"));
          }),
        },
      ],
    },
    deleteByOwner: {
      write: [
        {
          name: "removes every client of the owner, revoked or not, and nobody else's; idempotent",
          run: Effect.gen(function* () {
            const records = yield* ApiKeyClientRecords.ApiKeyClientRecords;
            yield* records.insert(client("a"));
            yield* records.insert(client("b", { revokedAt: Option.some(at(2_000)) }));
            yield* records.insert(client("c", { ownerId: other }));
            yield* records.deleteByOwner(owner);
            yield* records.deleteByOwner(owner);
            assert.deepStrictEqual(yield* records.listByOwner(owner), []);
            assert.deepStrictEqual(
              (yield* records.listByOwner(other)).map((record) => record.clientId),
              ["c"],
            );
          }),
        },
      ],
    },
  },
  sql: [
    {
      name: "plan 24: a store outage on insert is StoreUnavailable naming ApiKeyClientRecords.insert",
      run: Effect.gen(function* () {
        yield* TestSql.injectFailure({
          name: "apikey_client_fail_insert",
          table: "apikey_client",
          event: "INSERT",
        });
        const records = yield* ApiKeyClientRecords.ApiKeyClientRecords;
        const failure = yield* Effect.flip(records.insert(client("a")));
        assert.strictEqual(failure._tag, "StoreUnavailable");
        assert.strictEqual(failure.operation, "ApiKeyClientRecords.insert");
      }),
    },
  ],
});
