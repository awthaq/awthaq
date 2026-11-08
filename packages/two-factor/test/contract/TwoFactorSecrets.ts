// Plan 25 ticket 21 (ADR-EA-041 decision 9): `TwoFactorSecrets`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`, a fresh store per case. THS-001 step 3, THS-005 (BEH-EA-264/265): one
// secret per user, sealed at rest; a pending secret is replaced until the first valid code confirms it, and a
// confirmed one is final; `lastUsedStep` is the replay guard. Every state change is one conditional statement (one
// `Ref.modify` on memory), so a confirmation is never undone by a racing enable, a secret is confirmed once, and of
// any number of verifications of one step exactly one is accepted. These cases replace `TwoFactorStore.test.ts`'
// bespoke suite.
import { Users } from "@awthaq/core";
import { Encryption } from "@awthaq/ports";
import { SealedColumn } from "@awthaq/sql";
import { RecordsContract } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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

/** What a sealed secret holds, opened through the substrate. */
const openSecret = (sealed: SealedColumn.Sealed<string>) =>
  Effect.map(SealedColumn.orDie(sealed.open), Redacted.value);

const stored = (userId: Users.UserId) =>
  Effect.flatMap(TwoFactorStore.TwoFactorSecrets, (secrets) =>
    Effect.map(secrets.find(userId), Option.getOrThrow),
  );

/** A confirmed secret whose last accepted step is `step`. */
const confirmed = (userId: Users.UserId, step: bigint) =>
  Effect.gen(function* () {
    const secrets = yield* TwoFactorStore.TwoFactorSecrets;
    assert.isTrue(yield* secrets.upsertPending(userId, Redacted.make("JBSWY3DPEHPK3PXP")));
    assert.isTrue(yield* secrets.confirm(userId, step));
  });

/** Steps 2 to 9, latest first: a lost update would leave an earlier step written last. */
const steps = Array.from({ length: RecordsContract.CONCURRENCY }, (_, index) =>
  BigInt(RecordsContract.CONCURRENCY + 1 - index),
);

export const twoFactorSecrets = RecordsContract.suite(TwoFactorStore.TwoFactorSecrets, {
  operations: {
    find: {
      read: [
        {
          name: "None for a user with no secret; a pending secret reads back sealed, unconfirmed, with no step",
          run: Effect.gen(function* () {
            const secrets = yield* TwoFactorStore.TwoFactorSecrets;
            assert.isTrue(Option.isNone(yield* secrets.find(userA)));
            yield* secrets.upsertPending(userA, Redacted.make("secret-a"));
            const pending = yield* stored(userA);
            assert.strictEqual(pending.userId, userA);
            assert.strictEqual(yield* openSecret(pending.secret), "secret-a");
            assert.isTrue(Option.isNone(pending.confirmedAt));
            assert.isTrue(Option.isNone(pending.lastUsedStep));
            assert.isTrue(Option.isNone(yield* secrets.find(userB)));
          }),
        },
      ],
    },
    upsertPending: {
      atomic: [
        {
          name: "a pending secret is replaced until it is confirmed, then it is final",
          run: Effect.gen(function* () {
            const secrets = yield* TwoFactorStore.TwoFactorSecrets;
            assert.isTrue(yield* secrets.upsertPending(userA, Redacted.make("secret-1")));
            assert.isTrue(yield* secrets.upsertPending(userA, Redacted.make("secret-2")));
            assert.strictEqual(yield* openSecret((yield* stored(userA)).secret), "secret-2");
            assert.isTrue(yield* secrets.confirm(userA, BigInt(100)));

            // A confirmed secret is never overwritten by a fresh `enable`.
            assert.isFalse(yield* secrets.upsertPending(userA, Redacted.make("secret-3")));
            const kept = yield* stored(userA);
            assert.strictEqual(yield* openSecret(kept.secret), "secret-2");
            assert.isTrue(Option.isSome(kept.confirmedAt));
            assert.deepStrictEqual(kept.lastUsedStep, Option.some(BigInt(100)));
          }),
        },
        {
          name: "another user's secret is untouched",
          run: Effect.gen(function* () {
            const secrets = yield* TwoFactorStore.TwoFactorSecrets;
            yield* confirmed(userB, BigInt(7));
            assert.isTrue(yield* secrets.upsertPending(userA, Redacted.make("secret-a")));
            const theirs = yield* stored(userB);
            assert.strictEqual(yield* openSecret(theirs.secret), "JBSWY3DPEHPK3PXP");
            assert.deepStrictEqual(theirs.lastUsedStep, Option.some(BigInt(7)));
          }),
        },
      ],
      race: [
        {
          name: "enables racing a confirmation never undo it: the factor stays confirmed with the step that proved it",
          run: Effect.gen(function* () {
            const secrets = yield* TwoFactorStore.TwoFactorSecrets;
            const encryption = yield* Encryption.Encryption;
            // Rounds, so the confirmation lands at different points among the enables' reads and writes.
            for (let round = 0; round < RecordsContract.CONCURRENCY; round++) {
              const user = Users.UserId(`user-${round}`);
              yield* secrets.upsertPending(user, Redacted.make("secret-0"));
              const enables = Array.from({ length: RecordsContract.CONCURRENCY - 1 }, (_, index) =>
                secrets.upsertPending(user, Redacted.make(`secret-${index + 1}`)),
              );
              // A few encryptions first (more each round), as each enable seals before it writes: in some round
              // the confirmation lands among the enables' writes.
              const confirmation = Effect.andThen(
                Effect.forEach(Array.from({ length: round }), () =>
                  encryption.encrypt(Redacted.make("delay"), "two-factor-contract"),
                ),
                secrets.confirm(user, BigInt(100)),
              );
              const results = yield* Effect.all(
                [...enables.slice(0, round), confirmation, ...enables.slice(round)],
                { concurrency: "unbounded" },
              ).pipe(fineGrained);
              // The row is unconfirmed until the one confirmation runs, so it always wins.
              assert.isTrue(results[round]);
              const kept = yield* stored(user);
              assert.isTrue(Option.isSome(kept.confirmedAt));
              assert.deepStrictEqual(kept.lastUsedStep, Option.some(BigInt(100)));
              assert.isFalse(yield* secrets.upsertPending(user, Redacted.make("late")));
            }
          }),
        },
      ],
    },
    confirm: {
      atomic: [
        {
          name: "confirm records the step of the code that proved it, exactly once",
          run: Effect.gen(function* () {
            const secrets = yield* TwoFactorStore.TwoFactorSecrets;
            yield* secrets.upsertPending(userA, Redacted.make("secret-a"));
            assert.isTrue(yield* secrets.confirm(userA, BigInt(100)));
            assert.isFalse(yield* secrets.confirm(userA, BigInt(101)));
            const kept = yield* stored(userA);
            assert.isTrue(Option.isSome(kept.confirmedAt));
            assert.deepStrictEqual(kept.lastUsedStep, Option.some(BigInt(100)));
          }),
        },
        {
          name: "false for a user with no secret, and nothing is created",
          run: Effect.gen(function* () {
            const secrets = yield* TwoFactorStore.TwoFactorSecrets;
            assert.isFalse(yield* secrets.confirm(userA, BigInt(1)));
            assert.isTrue(Option.isNone(yield* secrets.find(userA)));
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent confirmations with different steps: exactly one wins, and its step is the one stored",
          run: Effect.gen(function* () {
            const secrets = yield* TwoFactorStore.TwoFactorSecrets;
            yield* secrets.upsertPending(userA, Redacted.make("secret-a"));
            const results = yield* Effect.all(
              steps.map((step) => secrets.confirm(userA, step)),
              { concurrency: "unbounded" },
            ).pipe(fineGrained);
            const winners = steps.filter((_, index) => results[index]);
            assert.strictEqual(winners.length, 1);
            assert.deepStrictEqual(
              (yield* stored(userA)).lastUsedStep,
              Option.fromNullishOr(winners[0]),
            );
          }),
        },
      ],
    },
    advanceLastUsedStep: {
      atomic: [
        {
          name: "THS-005: lastUsedStep only moves forward, and never on an unconfirmed secret",
          run: Effect.gen(function* () {
            const secrets = yield* TwoFactorStore.TwoFactorSecrets;
            assert.isFalse(yield* secrets.advanceLastUsedStep(userA, BigInt(5)));
            yield* secrets.upsertPending(userA, Redacted.make("e"));
            // Not yet confirmed: no step can be spent.
            assert.isFalse(yield* secrets.advanceLastUsedStep(userA, BigInt(5)));
            yield* secrets.confirm(userA, BigInt(10));
            assert.isFalse(yield* secrets.advanceLastUsedStep(userA, BigInt(10)));
            assert.isFalse(yield* secrets.advanceLastUsedStep(userA, BigInt(9)));
            assert.isTrue(yield* secrets.advanceLastUsedStep(userA, BigInt(11)));
            assert.isFalse(yield* secrets.advanceLastUsedStep(userA, BigInt(11)));
            assert.deepStrictEqual((yield* stored(userA)).lastUsedStep, Option.some(BigInt(11)));
          }),
        },
      ],
      race: [
        {
          name: "THS-005: of 8 concurrent verifications of one step, exactly one wins",
          run: Effect.gen(function* () {
            const secrets = yield* TwoFactorStore.TwoFactorSecrets;
            yield* confirmed(userA, BigInt(1));
            const results = yield* RecordsContract.race(
              secrets.advanceLastUsedStep(userA, BigInt(2)),
            ).pipe(fineGrained);
            assert.strictEqual(results.filter(Boolean).length, 1);
            assert.deepStrictEqual((yield* stored(userA)).lastUsedStep, Option.some(BigInt(2)));
          }),
        },
        {
          name: "8 concurrent verifications of different steps never move the step backwards: the latest is stored",
          run: Effect.gen(function* () {
            const secrets = yield* TwoFactorStore.TwoFactorSecrets;
            yield* confirmed(userA, BigInt(1));
            const results = yield* Effect.all(
              steps.map((step) => secrets.advanceLastUsedStep(userA, step)),
              { concurrency: "unbounded" },
            ).pipe(fineGrained);
            // The latest step is later than every other, so it is always accepted.
            assert.isTrue(results[0]);
            assert.deepStrictEqual(
              (yield* stored(userA)).lastUsedStep,
              Option.some(BigInt(RecordsContract.CONCURRENCY + 1)),
            );
          }),
        },
      ],
    },
    delete: {
      write: [
        {
          name: "delete reports whether a row existed and leaves other users alone",
          run: Effect.gen(function* () {
            const secrets = yield* TwoFactorStore.TwoFactorSecrets;
            yield* secrets.upsertPending(userA, Redacted.make("a"));
            yield* secrets.upsertPending(userB, Redacted.make("b"));
            assert.isTrue(yield* secrets.delete(userA));
            assert.isFalse(yield* secrets.delete(userA));
            assert.isTrue(Option.isNone(yield* secrets.find(userA)));
            assert.isTrue(Option.isSome(yield* secrets.find(userB)));
          }),
        },
        {
          name: "a confirmed secret is deleted too, and a fresh enable starts over",
          run: Effect.gen(function* () {
            const secrets = yield* TwoFactorStore.TwoFactorSecrets;
            yield* confirmed(userA, BigInt(9));
            assert.isTrue(yield* secrets.delete(userA));
            assert.isTrue(yield* secrets.upsertPending(userA, Redacted.make("fresh")));
            const fresh = yield* stored(userA);
            assert.isTrue(Option.isNone(fresh.confirmedAt));
            assert.isTrue(Option.isNone(fresh.lastUsedStep));
          }),
        },
      ],
    },
  },
});
