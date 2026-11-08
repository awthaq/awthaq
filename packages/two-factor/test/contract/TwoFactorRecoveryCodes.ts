// Plan 25 ticket 21 (ADR-EA-041 decision 9): `TwoFactorRecoveryCodes`' contract, run on memory and SQL (Postgres
// under `pnpm test:pg`) from `Contract.test.ts`, a fresh store per case. BCR-002 (BEH-EA-264): a user's codes are
// hashed, one row each; `replaceAll` swaps the whole set as one step (a failure part-way keeps the old set, and
// concurrent regenerations leave exactly one whole set, serialised under the user's
// `two_factor_recovery_code:user:<id>` lock on Postgres), and `markUsed` is one compare-and-set, so a code is spent
// once. These cases replace `TwoFactorStore.test.ts`' bespoke suite and its SQL atomicity case.
import { Users } from "@awthaq/core";
import { PasswordHasher } from "@awthaq/ports";
import { RecordsContract, TestSql } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Scheduler from "effect/Scheduler";
import * as TwoFactorStore from "../../src/TwoFactorStore.ts";

const userA = Users.UserId("user-a");
const userB = Users.UserId("user-b");

/**
 * Racing fibers yield to the scheduler every few steps, so they interleave between a read and a write.
 * (Effect 4.1.2 stalls with a budget below 4.)
 */
const fineGrained = Effect.provideService(Scheduler.MaxOpsBeforeYield, 4);

const hash = (text: string) => PasswordHasher.PhcHash(`$argon2id$test$${text}`);

/** The hashes of a user's unused codes, sorted. */
const unusedHashes = (userId: Users.UserId) =>
  Effect.flatMap(TwoFactorStore.TwoFactorRecoveryCodes, (codes) =>
    Effect.map(codes.listUnused(userId), (rows) =>
      rows.map((row) => Redacted.value(row.codeHash)).sort(),
    ),
  );

/** The id of the user's one unused code. */
const onlyCode = (userId: Users.UserId) =>
  Effect.flatMap(TwoFactorStore.TwoFactorRecoveryCodes, (codes) =>
    Effect.flatMap(codes.listUnused(userId), (rows) =>
      rows.length === 1 && rows[0] !== undefined
        ? Effect.succeed(rows[0].id)
        : Effect.die(`expected one code, found ${rows.length}`),
    ),
  );

export const twoFactorRecoveryCodes = RecordsContract.suite(TwoFactorStore.TwoFactorRecoveryCodes, {
  operations: {
    replaceAll: {
      atomic: [
        {
          name: "BCR-002: replaceAll swaps the whole set, spent codes included, for that user only",
          run: Effect.gen(function* () {
            const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
            yield* codes.replaceAll(userA, [hash("1"), hash("2"), hash("3")]);
            yield* codes.replaceAll(userB, [hash("b1")]);
            const [first] = yield* codes.listUnused(userA);
            if (first === undefined) return assert.fail("no codes");
            assert.isTrue(yield* codes.markUsed(userA, first.id));

            yield* codes.replaceAll(userA, [hash("x"), hash("y")]);
            const fresh = yield* codes.listUnused(userA);
            assert.strictEqual(fresh.length, 2);
            assert.isFalse(fresh.some((row) => row.id === first.id));
            assert.deepStrictEqual(yield* unusedHashes(userA), [hash("x"), hash("y")]);
            // The replaced set is gone, the spent code included: it cannot be spent again.
            assert.isFalse(yield* codes.markUsed(userA, first.id));
            assert.deepStrictEqual(yield* unusedHashes(userB), [hash("b1")]);
          }),
        },
        {
          name: "an empty set leaves the user with no codes",
          run: Effect.gen(function* () {
            const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
            yield* codes.replaceAll(userA, [hash("1")]);
            yield* codes.replaceAll(userA, []);
            assert.strictEqual(yield* codes.countUnused(userA), 0);
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent regenerations leave exactly one whole set, and other users' codes untouched",
          run: Effect.gen(function* () {
            const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
            yield* codes.replaceAll(userA, [hash("old-1"), hash("old-2")]);
            yield* codes.replaceAll(userB, [hash("b1")]);
            const sets = Array.from({ length: RecordsContract.CONCURRENCY }, (_, caller) =>
              [1, 2, 3].map((index) => hash(`caller-${caller}-${index}`)).sort(),
            );
            yield* Effect.all(
              sets.map((set) => codes.replaceAll(userA, set)),
              { concurrency: "unbounded" },
            ).pipe(fineGrained);
            const left = yield* unusedHashes(userA);
            assert.strictEqual(left.length, 3);
            assert.isTrue(sets.some((set) => set.every((code, index) => left[index] === code)));
            assert.deepStrictEqual(yield* unusedHashes(userB), [hash("b1")]);
          }),
        },
      ],
    },
    listUnused: {
      read: [
        {
          name: "this user's unused codes only: never a spent one, never another user's",
          run: Effect.gen(function* () {
            const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
            assert.deepStrictEqual(yield* codes.listUnused(userA), []);
            yield* codes.replaceAll(userA, [hash("1"), hash("2")]);
            yield* codes.replaceAll(userB, [hash("b1")]);
            const [first] = yield* codes.listUnused(userA);
            if (first === undefined) return assert.fail("no codes");
            yield* codes.markUsed(userA, first.id);
            const left = yield* codes.listUnused(userA);
            assert.strictEqual(left.length, 1);
            assert.notStrictEqual(left[0]?.id, first.id);
            assert.deepStrictEqual(yield* unusedHashes(userB), [hash("b1")]);
          }),
        },
      ],
    },
    markUsed: {
      atomic: [
        {
          name: "a code is spent once, and another user's id cannot be spent through this user",
          run: Effect.gen(function* () {
            const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
            yield* codes.replaceAll(userA, [hash("1"), hash("2"), hash("3")]);
            yield* codes.replaceAll(userB, [hash("b1")]);
            const [first] = yield* codes.listUnused(userA);
            if (first === undefined) return assert.fail("no codes");
            assert.isTrue(yield* codes.markUsed(userA, first.id));
            assert.isFalse(yield* codes.markUsed(userA, first.id));
            assert.strictEqual(yield* codes.countUnused(userA), 2);
            const theirs = yield* onlyCode(userB);
            assert.isFalse(yield* codes.markUsed(userA, theirs));
            assert.strictEqual(yield* codes.countUnused(userB), 1);
            assert.isFalse(yield* codes.markUsed(userA, "no-such-code"));
          }),
        },
      ],
      race: [
        {
          name: "BCR-002: a recovery code presented 8 times concurrently is spent exactly once",
          run: Effect.gen(function* () {
            const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
            yield* codes.replaceAll(userA, [hash("only")]);
            const id = yield* onlyCode(userA);
            const results = yield* RecordsContract.race(codes.markUsed(userA, id)).pipe(
              fineGrained,
            );
            assert.strictEqual(results.filter(Boolean).length, 1);
            assert.strictEqual(yield* codes.countUnused(userA), 0);
          }),
        },
      ],
    },
    countUnused: {
      read: [
        {
          name: "BCR-002: 0 for a user without codes, then the unused count of that user, tracking each spend",
          run: Effect.gen(function* () {
            const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
            assert.strictEqual(yield* codes.countUnused(userA), 0);
            yield* codes.replaceAll(userA, [hash("1"), hash("2"), hash("3")]);
            yield* codes.replaceAll(userB, [hash("b1")]);
            assert.strictEqual(yield* codes.countUnused(userA), 3);
            const [first] = yield* codes.listUnused(userA);
            if (first === undefined) return assert.fail("no codes");
            yield* codes.markUsed(userA, first.id);
            assert.strictEqual(yield* codes.countUnused(userA), 2);
            assert.strictEqual(yield* codes.countUnused(userB), 1);
          }),
        },
      ],
    },
    deleteAllByUser: {
      write: [
        {
          name: "deleteAllByUser removes every code of that user only, spent ones included",
          run: Effect.gen(function* () {
            const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
            yield* codes.replaceAll(userA, [hash("1"), hash("2")]);
            yield* codes.replaceAll(userB, [hash("b1")]);
            const [first] = yield* codes.listUnused(userA);
            if (first === undefined) return assert.fail("no codes");
            yield* codes.markUsed(userA, first.id);
            yield* codes.deleteAllByUser(userA);
            assert.strictEqual(yield* codes.countUnused(userA), 0);
            assert.isFalse(yield* codes.markUsed(userA, first.id));
            assert.strictEqual(yield* codes.countUnused(userB), 1);
            yield* codes.deleteAllByUser(userA);
          }),
        },
      ],
    },
  },
  sql: [
    {
      name: "BCR-002: a failure while inserting the new set leaves the old set intact",
      run: Effect.gen(function* () {
        const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
        yield* codes.replaceAll(userA, [hash("old-1"), hash("old-2")]);
        const before = (yield* codes.listUnused(userA)).map((row) => row.id).sort();

        // The delete succeeds, then the first insert fails: without the transaction the user would have no codes at all.
        yield* TestSql.injectFailure({
          name: "two_factor_fail_insert",
          table: "two_factor_recovery_code",
          event: "INSERT",
        });
        const failure = yield* Effect.flip(codes.replaceAll(userA, [hash("new-1")]));
        assert.strictEqual(failure._tag, "StoreUnavailable");
        assert.strictEqual(failure.operation, "TwoFactorRecoveryCodes.replaceAll");
        assert.deepStrictEqual(
          (yield* codes.listUnused(userA)).map((row) => row.id).sort(),
          before,
        );
      }),
    },
  ],
});
