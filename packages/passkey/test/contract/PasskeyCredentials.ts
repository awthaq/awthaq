// Plan 25 ticket 18 (ADR-EA-041 decision 9): `PasskeyCredentials`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`, a fresh store per case. BEH-EA-130/131/134. F8: `recordUsage` decides the
// counter verdict at the write (CB-004): above the stored counter, or both 0, advances; anything else is
// `"regressed"` and writes nothing, so of any number of concurrent assertions with one counter exactly one advances.
import { Users } from "@awthaq/core";
import { RecordsContract } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import * as PasskeyCredentials from "../../src/PasskeyCredentials.ts";

const userA = Users.UserId("user-a");
const userB = Users.UserId("user-b");

type NewCredential = Parameters<PasskeyCredentials.PasskeyCredentialsShape["create"]>[0];

const seed = (id: string, userId: Users.UserId = userA, counter = 0): NewCredential => ({
  id,
  userId,
  webauthnUserId: `wau-${id}`,
  publicKey: new Uint8Array([9, 9]),
  counter,
  deviceType: "singleDevice",
  backedUp: false,
  transports: [],
  aaguid: "00000000-0000-0000-0000-000000000000",
  name: id,
});

const stored = (id: string) =>
  Effect.flatMap(PasskeyCredentials.PasskeyCredentials, (credentials) =>
    Effect.map(credentials.findById(id), Option.getOrThrow),
  );

const absent = (id: string) =>
  Effect.flatMap(PasskeyCredentials.PasskeyCredentials, (credentials) =>
    Effect.map(credentials.findById(id), Option.isNone),
  );

/**
 * Racing fibers yield to the scheduler every few steps, so they interleave between a read and a write.
 * (Effect 4.1.2 stalls with a budget below 4.)
 */
const fineGrained = Effect.provideService(Scheduler.MaxOpsBeforeYield, 4);

const succeeded = <A, E>(exits: ReadonlyArray<Exit.Exit<A, E>>) =>
  exits.flatMap((exit) => (Exit.isSuccess(exit) ? [exit.value] : []));

export const passkeyCredentials = RecordsContract.suite(PasskeyCredentials.PasskeyCredentials, {
  operations: {
    create: {
      atomic: [
        {
          name: "create then findById round-trips every field",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            yield* credentials.create({
              ...seed("cred-1"),
              publicKey: new Uint8Array([1, 2, 3]),
              transports: ["internal"],
              name: "My Passkey",
            });
            const found = yield* stored("cred-1");
            assert.strictEqual(found.userId, userA);
            assert.deepStrictEqual(found.publicKey, new Uint8Array([1, 2, 3]));
            assert.deepStrictEqual(found.transports, ["internal"]);
            assert.strictEqual(found.name, "My Passkey");
            assert.strictEqual(found.counter, 0);
            assert.isTrue(Option.isNone(found.counterAnomalyAt));
            assert.strictEqual(found.counterAnomalyCount, 0);
          }),
        },
        {
          name: "WPS-010: an existing credential id fails PasskeyCredentialAlreadyExists and keeps the original owner",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            yield* credentials.create(seed("cred-dup", userA));
            const failure = yield* Effect.flip(credentials.create(seed("cred-dup", userB)));
            assert.strictEqual(failure._tag, "PasskeyCredentialAlreadyExists");
            assert.strictEqual((yield* stored("cred-dup")).userId, userA);
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent creates of one id: exactly one stored, the others AlreadyExists",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            const exits = yield* RecordsContract.race(
              Effect.exit(credentials.create(seed("cred"))),
            );
            assert.strictEqual(succeeded(exits).length, 1);
            for (const exit of exits) {
              if (Exit.isFailure(exit)) {
                assert.isTrue(
                  Exit.findErrorOption(exit).pipe(
                    Option.exists((error) => error._tag === "PasskeyCredentialAlreadyExists"),
                  ),
                );
              }
            }
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
    listByUser: {
      read: [
        {
          name: "lists only that user's own credentials",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            yield* credentials.create(seed("cred-a1", userA));
            yield* credentials.create(seed("cred-a2", userA));
            yield* credentials.create(seed("cred-b1", userB));
            const listed = yield* credentials.listByUser(userA);
            assert.deepStrictEqual(listed.map((row) => row.id).sort(), ["cred-a1", "cred-a2"]);
            assert.deepStrictEqual(yield* credentials.listByUser(Users.UserId("nobody")), []);
          }),
        },
      ],
    },
    recordUsage: {
      atomic: [
        {
          name: "an advancing counter is advanced and stores the counter, backup state and last-used time",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            yield* credentials.create(seed("cred-usage"));
            const before = yield* stored("cred-usage");
            yield* TestClock.adjust(Duration.seconds(10));
            assert.strictEqual(yield* credentials.recordUsage("cred-usage", 7, true), "advanced");
            const after = yield* stored("cred-usage");
            assert.strictEqual(after.counter, 7);
            assert.isTrue(after.backedUp);
            assert.strictEqual(
              DateTime.toEpochMillis(after.lastUsedAt) - DateTime.toEpochMillis(before.lastUsedAt),
              10_000,
            );
          }),
        },
        {
          name: "CB-004: a lower or equal counter is regressed and writes nothing",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            yield* credentials.create(seed("cred-counter"));
            assert.strictEqual(
              yield* credentials.recordUsage("cred-counter", 5, false),
              "advanced",
            );
            const before = yield* stored("cred-counter");
            yield* TestClock.adjust(Duration.seconds(10));
            assert.strictEqual(
              yield* credentials.recordUsage("cred-counter", 3, true),
              "regressed",
            );
            assert.strictEqual(
              yield* credentials.recordUsage("cred-counter", 5, true),
              "regressed",
            );
            const after = yield* stored("cred-counter");
            assert.strictEqual(after.counter, 5);
            assert.isFalse(after.backedUp);
            assert.isTrue(DateTime.Equivalence(after.lastUsedAt, before.lastUsedAt));
            assert.strictEqual(
              yield* credentials.recordUsage("cred-counter", 9, false),
              "advanced",
            );
            assert.strictEqual((yield* stored("cred-counter")).counter, 9);
          }),
        },
        {
          name: "BEH-EA-131: 0 over a stored 0 (an authenticator that never counts) advances, every time",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            yield* credentials.create(seed("cred-zero"));
            assert.strictEqual(yield* credentials.recordUsage("cred-zero", 0, true), "advanced");
            assert.strictEqual(yield* credentials.recordUsage("cred-zero", 0, false), "advanced");
            assert.isFalse((yield* stored("cred-zero")).backedUp);
            yield* credentials.recordUsage("cred-zero", 1, false);
            assert.strictEqual(yield* credentials.recordUsage("cred-zero", 0, false), "regressed");
          }),
        },
        {
          // Plan 22, D2: a WebAuthn signCount is a uint32; fails on Postgres alone while the column is int4.
          name: "a signature counter up to 2^32 - 1 advances and round-trips",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            const max = 2 ** 32 - 1;
            yield* credentials.create(seed("cred-wide", userA, max - 1));
            assert.strictEqual(yield* credentials.recordUsage("cred-wide", max, false), "advanced");
            assert.strictEqual((yield* stored("cred-wide")).counter, max);
            assert.strictEqual(
              yield* credentials.recordUsage("cred-wide", max, false),
              "regressed",
            );
          }),
        },
        {
          name: "an unknown credential is PasskeyCredentials/NotFound",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            const failure = yield* Effect.flip(credentials.recordUsage("nope", 1, false));
            assert.strictEqual(failure._tag, "PasskeyCredentials/NotFound");
            assert.isTrue(yield* absent("nope"));
          }),
        },
      ],
      race: [
        {
          name: "F8: 8 concurrent assertions with the same counter: exactly one advances, the others regressed",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            yield* credentials.create(seed("cred-race", userA, 4));
            const verdicts = yield* RecordsContract.race(
              credentials.recordUsage("cred-race", 5, false),
            ).pipe(fineGrained);
            assert.strictEqual(verdicts.filter((verdict) => verdict === "advanced").length, 1);
            assert.strictEqual(
              verdicts.filter((verdict) => verdict === "regressed").length,
              RecordsContract.CONCURRENCY - 1,
            );
            assert.strictEqual((yield* stored("cred-race")).counter, 5);
          }),
        },
        {
          name: "F8: 8 concurrent assertions with counters 1..8: the stored counter ends at 8, never lowered",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            yield* credentials.create(seed("cred-spread"));
            const verdicts = yield* Effect.all(
              Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) =>
                credentials.recordUsage("cred-spread", n + 1, false),
              ),
              { concurrency: "unbounded" },
            );
            assert.isAtLeast(verdicts.filter((verdict) => verdict === "advanced").length, 1);
            assert.strictEqual((yield* stored("cred-spread")).counter, RecordsContract.CONCURRENCY);
          }),
        },
      ],
    },
    rename: {
      write: [
        {
          name: "renames the owner's credential; another user's is NotFound and keeps its name",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            yield* credentials.create(seed("cred-rename"));
            const wrongOwner = yield* Effect.flip(
              credentials.rename("cred-rename", userB, "Stolen"),
            );
            assert.strictEqual(wrongOwner._tag, "PasskeyCredentials/NotFound");
            assert.strictEqual((yield* stored("cred-rename")).name, "cred-rename");
            const renamed = yield* credentials.rename("cred-rename", userA, "Renamed");
            assert.strictEqual(renamed.name, "Renamed");
            assert.strictEqual((yield* stored("cred-rename")).name, "Renamed");
            const unknown = yield* Effect.flip(credentials.rename("nope", userA, "x"));
            assert.strictEqual(unknown._tag, "PasskeyCredentials/NotFound");
          }),
        },
      ],
    },
    delete: {
      write: [
        {
          name: "fails identically for an unknown id and another user's, succeeds for the owner",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            yield* credentials.create(seed("cred-delete"));
            const unknown = yield* Effect.flip(credentials.delete("does-not-exist", userA));
            const wrongOwner = yield* Effect.flip(credentials.delete("cred-delete", userB));
            assert.strictEqual(unknown._tag, "PasskeyCredentials/NotFound");
            assert.strictEqual(wrongOwner._tag, "PasskeyCredentials/NotFound");
            assert.isFalse(yield* absent("cred-delete"));
            yield* credentials.delete("cred-delete", userA);
            assert.isTrue(yield* absent("cred-delete"));
          }),
        },
      ],
    },
    flagCounterAnomaly: {
      atomic: [
        {
          name: "WPS-006: stamps the credential and counts each anomaly, leaving the counter",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            yield* credentials.create(seed("cred-flag", userA, 3));
            yield* credentials.flagCounterAnomaly("cred-flag");
            yield* credentials.flagCounterAnomaly("cred-flag");
            const after = yield* stored("cred-flag");
            assert.isTrue(Option.isSome(after.counterAnomalyAt));
            assert.strictEqual(after.counterAnomalyCount, 2);
            assert.strictEqual(after.counter, 3);
          }),
        },
        {
          name: "WPS-006: an unknown credential is PasskeyCredentials/NotFound",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            const failure = yield* Effect.flip(credentials.flagCounterAnomaly("nope"));
            assert.strictEqual(failure._tag, "PasskeyCredentials/NotFound");
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent flags count 8 anomalies",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            yield* credentials.create(seed("cred-flags"));
            yield* RecordsContract.race(credentials.flagCounterAnomaly("cred-flags"));
            assert.strictEqual(
              (yield* stored("cred-flags")).counterAnomalyCount,
              RecordsContract.CONCURRENCY,
            );
          }),
        },
      ],
    },
    deleteAllByUser: {
      write: [
        {
          name: "CSG-001: removes every credential of the user and nobody else's; idempotent",
          run: Effect.gen(function* () {
            const credentials = yield* PasskeyCredentials.PasskeyCredentials;
            yield* credentials.create(seed("cred-a1", userA));
            yield* credentials.create(seed("cred-a2", userA));
            yield* credentials.create(seed("cred-b1", userB));
            yield* credentials.deleteAllByUser(userA);
            yield* credentials.deleteAllByUser(userA);
            assert.deepStrictEqual(yield* credentials.listByUser(userA), []);
            assert.isFalse(yield* absent("cred-b1"));
          }),
        },
      ],
    },
  },
});
