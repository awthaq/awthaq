// Plan 25 ticket 24 (ADR-EA-041 decision 9): the `UserClaimsRecords` contract (key `awthaq/qadi/records/UserClaims`),
// run on memory and SQL (Postgres under `pnpm test:pg`) from `Contract.test.ts`, a fresh store per case. FAMS-004:
// one JSON document per user; `modify` rewrites it as one step and answers both sides, so `UserClaims` publishes
// `claimsUpdated` for exactly the keys that changed. Plan 24 C7: the SQL read and write run under the user's
// `SqlStore.atomically` lock (`qadi_claims:user:<id>`), so concurrent merges never lose a key on Postgres.
// These cases replace the store half of `UserClaims.test.ts`' bespoke `contract(...)` and its outage case.
// `claims_user` is Global, so the suite has no tenancy cases.
import { Users } from "@awthaq/core";
import { RecordsContract, TestSql } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scheduler from "effect/Scheduler";
import * as SqlClient from "effect/sql/SqlClient";
import * as UserClaims from "../../src/UserClaims.ts";

const alice = Users.UserId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const bob = Users.UserId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

/**
 * Racing fibers yield to the scheduler every few steps, so they interleave between a read and a write.
 * (Effect 4.1.2 stalls with a budget below 4.)
 */
const fineGrained = Effect.provideService(Scheduler.MaxOpsBeforeYield, 4);

const replaceWith =
  (claims: UserClaims.Claims) =>
  (_current: UserClaims.Claims): UserClaims.Claims =>
    claims;

const withKey =
  (key: string, value: number) =>
  (current: UserClaims.Claims): UserClaims.Claims => ({ ...current, [key]: value });

export const userClaims = RecordsContract.suite(UserClaims.UserClaimsRecords, {
  operations: {
    read: {
      read: [
        {
          name: "a user with no claims reads as an empty record; claims are per user",
          run: Effect.gen(function* () {
            const store = yield* UserClaims.UserClaimsRecords;
            assert.deepStrictEqual(yield* store.read(alice), {});
            yield* store.modify(alice, replaceWith({ plan: "pro", seats: 3, beta: true }));
            yield* store.modify(bob, replaceWith({ plan: "free" }));
            assert.deepStrictEqual(yield* store.read(alice), { plan: "pro", seats: 3, beta: true });
            assert.deepStrictEqual(yield* store.read(bob), { plan: "free" });
          }),
        },
      ],
    },
    modify: {
      atomic: [
        {
          name: "rewrites one user's document and answers what it was and what it is",
          run: Effect.gen(function* () {
            const store = yield* UserClaims.UserClaimsRecords;
            const first = yield* store.modify(
              alice,
              replaceWith({ plan: "pro", nested: { a: [1, 2] } }),
            );
            assert.deepStrictEqual(first, {
              before: {},
              after: { plan: "pro", nested: { a: [1, 2] } },
            });
            const second = yield* store.modify(alice, withKey("seats", 5));
            assert.deepStrictEqual(second.before, { plan: "pro", nested: { a: [1, 2] } });
            assert.deepStrictEqual(second.after, { plan: "pro", nested: { a: [1, 2] }, seats: 5 });
            assert.deepStrictEqual(yield* store.read(alice), second.after);
            assert.deepStrictEqual(yield* store.read(bob), {});
          }),
        },
        {
          name: "an empty document removes the user's claims",
          run: Effect.gen(function* () {
            const store = yield* UserClaims.UserClaimsRecords;
            yield* store.modify(alice, replaceWith({ plan: "pro" }));
            const cleared = yield* store.modify(alice, replaceWith({}));
            assert.deepStrictEqual(cleared, { before: { plan: "pro" }, after: {} });
            assert.deepStrictEqual(yield* store.read(alice), {});
          }),
        },
      ],
      race: [
        {
          name: "plan 24 C7: 8 concurrent merges of distinct keys keep every key, each seeing the ones before it",
          run: Effect.gen(function* () {
            const store = yield* UserClaims.UserClaimsRecords;
            const keys = Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) => `k${n}`);
            const results = yield* Effect.all(
              keys.map((key, n) => store.modify(alice, withKey(key, n))),
              { concurrency: "unbounded" },
            ).pipe(fineGrained);
            assert.deepStrictEqual(Object.keys(yield* store.read(alice)).sort(), keys);
            // Serialised: the documents the 8 writers read hold 0, 1, … 7 keys.
            assert.deepStrictEqual(
              results.map((result) => Object.keys(result.before).length).sort(),
              keys.map((_, n) => n),
            );
          }),
        },
      ],
    },
  },
  sql: [
    {
      name: "an emptied document leaves no row behind",
      run: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* UserClaims.UserClaimsRecords;
        yield* store.modify(alice, replaceWith({ plan: "pro" }));
        yield* store.modify(alice, replaceWith({}));
        const rows = yield* sql`SELECT subject FROM claims_user WHERE subject = ${alice}`;
        assert.strictEqual(rows.length, 0);
      }),
    },
    {
      name: "plan 05 (ADR-EA-028): an outage is StoreUnavailable naming the operation, and keeps the document",
      run: Effect.gen(function* () {
        const store = yield* UserClaims.UserClaimsRecords;
        yield* store.modify(alice, replaceWith({ plan: "pro" }));
        yield* TestSql.injectFailure({
          name: "claims_fail_update",
          table: "claims_user",
          event: "UPDATE",
        });
        const failure = yield* store.modify(alice, withKey("seats", 1)).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "StoreUnavailable");
        assert.strictEqual(failure.operation, "UserClaims.modify");
        assert.deepStrictEqual(yield* store.read(alice), { plan: "pro" });
      }),
    },
  ],
});
