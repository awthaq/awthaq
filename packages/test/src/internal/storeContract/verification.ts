// @awthaq/test — the verification suite of StoreContract (plan 37)
import assert from "node:assert/strict";
import { Ids, Tenant, VerificationStore } from "@awthaq/ports";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CONCURRENCY, race } from "../contract.ts";
import { at, makeUserId } from "./fixtures.ts";
import { suite } from "./suite.ts";

const makeTokenId = Schema.decodeUnknownSync(Ids.VerificationTokenId);

const newToken = (
  id: string,
  identifier: string,
  valueHash: string,
  options: {
    readonly minutes?: number;
    readonly ttlMinutes?: number;
    readonly userId?: string;
    readonly maxAttempts?: number;
    readonly payload?: string;
  } = {},
): VerificationStore.NewToken => ({
  id: makeTokenId(id),
  identifier,
  userId: Option.map(Option.fromNullishOr(options.userId), makeUserId),
  valueHash,
  createdAt: at(options.minutes ?? 0),
  expiresAt: at((options.minutes ?? 0) + (options.ttlMinutes ?? 10)),
  payloadJson: Option.fromNullishOr(options.payload),
  maxAttempts: Option.fromNullishOr(options.maxAttempts),
});

const present = (
  identifier: string,
  valueHash: string,
  minutes = 1,
  hold = false,
): Effect.Effect<VerificationStore.PresentOutcome, unknown, VerificationStore.VerificationStore> =>
  Effect.flatMap(VerificationStore.VerificationStore, (store) =>
    store.present({ identifier, valueHash, now: at(minutes), hold }),
  );

/** The caller's transaction holds the claim and then fails, the case the give-back exists for. */
const heldThenFailed = (
  store: VerificationStore.VerificationStoreShape,
  identifier: string,
  valueHash: string,
) =>
  store
    .transaction(
      Effect.flatMap(present(identifier, valueHash, 1, true), (outcome) => {
        assert.equal(outcome._tag, "Hit");
        return Effect.fail("the caller refused");
      }),
    )
    .pipe(Effect.flip);

const hits = (outcomes: ReadonlyArray<VerificationStore.PresentOutcome>) =>
  outcomes.filter((outcome) => outcome._tag === "Hit").length;

/** The `VerificationStore` contract (plan 02, ADR-EA-041; BEH-EA-057 to 063, ADR-EA-016, SOS-004). */
export const verification = suite(VerificationStore.VerificationStore, {
  operations: {
    upsertLive: {
      atomic: [
        {
          name: "upsertLive stores the row with no attempts spent, nothing consumed, and the ambient tenant",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            const row = yield* Tenant.withTenant("tenant-a")(
              store.upsertLive(
                newToken("t1", "verify-email:u1", "h1", {
                  userId: "u1",
                  maxAttempts: 3,
                }),
              ),
            );
            assert.equal(row.attempts, 0);
            assert.deepEqual(row.consumedAt, Option.none());
            assert.deepEqual(row.tenantId, Option.some("tenant-a"));
            assert.deepEqual(row.maxAttempts, Option.some(3));
            assert.deepEqual(row.userId, Option.some("u1"));
          }),
        },
        {
          name: "upsertLive replaces the identifier's live row: the old value stops working, the new one works",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            yield* store.upsertLive(newToken("t1", "reset-password:u1", "old"));
            yield* store.upsertLive(newToken("t2", "reset-password:u1", "new"));
            assert.equal((yield* present("reset-password:u1", "old"))._tag, "Miss");
            assert.equal((yield* present("reset-password:u1", "new"))._tag, "Hit");
          }),
        },
        {
          name: "upsertLive keeps the consumed history of the identifier",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            yield* store.upsertLive(newToken("t1", "verify-email:u1", "h1", { userId: "u1" }));
            assert.equal((yield* present("verify-email:u1", "h1"))._tag, "Hit");
            yield* store.upsertLive(newToken("t2", "verify-email:u1", "h2", { userId: "u1" }));
            // Both the consumed row and the new live one name the user.
            assert.equal(yield* store.deleteByUser(makeUserId("u1")), 2);
          }),
        },
      ],
      race: [
        {
          name: "upsertLive under concurrency leaves exactly one live row: exactly one of 8 racing values works",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            yield* Effect.all(
              Array.from({ length: CONCURRENCY }, (_, index) =>
                store.upsertLive(newToken(`t${index}`, "verify-email:race", `hash-${index}`)),
              ),
              { concurrency: "unbounded" },
            );
            const outcomes = yield* Effect.all(
              Array.from({ length: CONCURRENCY }, (_, index) =>
                present("verify-email:race", `hash-${index}`),
              ),
            );
            assert.equal(hits(outcomes), 1);
          }),
        },
      ],
    },
    present: {
      atomic: [
        {
          name: "present is a Hit exactly once, returns the consumed row with its payload, and a replay is a Miss",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            const payload = JSON.stringify({
              codeVerifier: "v",
              note: 'aé "quoted" 100% _x_',
            });
            yield* store.upsertLive(newToken("t1", "oauth.flow:1", "h1", { payload }));
            const first = yield* present("oauth.flow:1", "h1", 2);
            assert.equal(first._tag, "Hit");
            if (first._tag === "Hit") {
              assert.equal(first.row.id, "t1");
              assert.deepEqual(first.row.consumedAt, Option.some(at(2)));
              assert.deepEqual(first.row.payloadJson, Option.some(payload));
            }
            assert.equal((yield* present("oauth.flow:1", "h1", 3))._tag, "Miss");
          }),
        },
        {
          name: "present never matches an unknown identifier or a wrong value, and a wrong value costs an unbudgeted token nothing",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            yield* store.upsertLive(newToken("t1", "verify-email:u1", "h1"));
            assert.equal((yield* present("verify-email:nobody", "h1"))._tag, "Miss");
            for (let i = 0; i < 10; i++)
              assert.equal((yield* present("verify-email:u1", "wrong"))._tag, "Miss");
            assert.equal((yield* present("verify-email:u1", "h1"))._tag, "Hit");
          }),
        },
        {
          name: "present refuses an expired token: a Hit one tick before expiresAt, a Miss at exactly expiresAt",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            yield* store.upsertLive(newToken("t1", "a", "h", { ttlMinutes: 10 }));
            yield* store.upsertLive(newToken("t2", "b", "h", { ttlMinutes: 10 }));
            const justBefore = DateTime.makeUnsafe(at(10).epochMilliseconds - 1);
            const early = yield* store.present({
              identifier: "a",
              valueHash: "h",
              now: justBefore,
              hold: false,
            });
            assert.equal(early._tag, "Hit");
            assert.equal((yield* present("b", "h", 10))._tag, "Miss");
          }),
        },
        {
          name: "a wrong value spends an attempt of a budgeted token, which is burned at maxAttempts (SOS-004)",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            yield* store.upsertLive(newToken("t1", "email-otp:u1", "right", { maxAttempts: 3 }));
            for (let i = 0; i < 3; i++)
              assert.equal((yield* present("email-otp:u1", "wrong"))._tag, "Miss");
            assert.equal((yield* present("email-otp:u1", "right"))._tag, "Miss");
          }),
        },
        {
          name: "fewer wrong values than the budget leave a budgeted token usable",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            yield* store.upsertLive(newToken("t1", "email-otp:u1", "right", { maxAttempts: 3 }));
            for (let i = 0; i < 2; i++)
              assert.equal((yield* present("email-otp:u1", "wrong"))._tag, "Miss");
            assert.equal((yield* present("email-otp:u1", "right"))._tag, "Hit");
          }),
        },
      ],
      race: [
        {
          name: "present under concurrency: exactly one of 8 presentations of the right value is a Hit (BEH-EA-062)",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            yield* store.upsertLive(newToken("t1", "reset-password:u1", "h1"));
            const outcomes = yield* race(present("reset-password:u1", "h1"));
            assert.equal(hits(outcomes), 1);
          }),
        },
        {
          name: "concurrent wrong values cannot overshoot the budget: 8 guesses against a budget of 3 burn the token",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            yield* store.upsertLive(newToken("t1", "email-otp:u1", "right", { maxAttempts: 3 }));
            yield* race(present("email-otp:u1", "wrong"));
            assert.equal((yield* present("email-otp:u1", "right"))._tag, "Miss");
          }),
        },
      ],
    },
    settle: {
      write: [
        {
          name: "a hold that is settled as kept leaves the token spent",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            yield* store.upsertLive(newToken("t1", "reset-password:u1", "h1"));
            yield* store.transaction(
              Effect.gen(function* () {
                assert.equal((yield* present("reset-password:u1", "h1", 1, true))._tag, "Hit");
              }),
            );
            yield* store.settle(makeTokenId("t1"), "kept");
            assert.equal((yield* present("reset-password:u1", "h1", 2))._tag, "Miss");
          }),
        },
        {
          name: "a hold given back after its caller's transaction failed is live again",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            yield* store.upsertLive(newToken("t1", "reset-password:u1", "h1"));
            yield* heldThenFailed(store, "reset-password:u1", "h1");
            yield* store.settle(makeTokenId("t1"), "returned");
            assert.equal((yield* present("reset-password:u1", "h1", 2))._tag, "Hit");
          }),
        },
        {
          name: "a newer upsertLive between the failure and the give-back wins over the hold given back",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            yield* store.upsertLive(newToken("t1", "reset-password:u1", "h1"));
            yield* heldThenFailed(store, "reset-password:u1", "h1");
            yield* store.upsertLive(newToken("t2", "reset-password:u1", "h2"));
            yield* store.settle(makeTokenId("t1"), "returned");
            assert.equal((yield* present("reset-password:u1", "h1", 2))._tag, "Miss");
            assert.equal((yield* present("reset-password:u1", "h2", 2))._tag, "Hit");
          }),
        },
        {
          name: "a deleteByUser between the failure and the give-back leaves nothing to be given back",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            yield* store.upsertLive(newToken("t1", "reset-password:u1", "h1", { userId: "u1" }));
            yield* heldThenFailed(store, "reset-password:u1", "h1");
            yield* store.deleteByUser(makeUserId("u1"));
            yield* store.settle(makeTokenId("t1"), "returned");
            assert.equal((yield* present("reset-password:u1", "h1", 2))._tag, "Miss");
          }),
        },
      ],
    },
    transaction: {
      write: [
        {
          name: "transaction runs its body once, returns its result, and passes its own failure through untouched",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            let runs = 0;
            const value = yield* store.transaction(
              Effect.sync(() => {
                runs += 1;
                return "result";
              }),
            );
            assert.equal(value, "result");
            assert.equal(runs, 1);
            const refusal = { refused: "the caller's own work" };
            const failure = yield* store.transaction(Effect.fail(refusal)).pipe(Effect.flip);
            assert.equal(failure, refusal);
          }),
        },
      ],
    },
    reserve: {
      atomic: [
        {
          name: "reserve is exclusive while live and free at exactly expiresAt; a zero ttl is free at once",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            const reserve = (identifier: string, minutes: number, ttlMinutes: number) =>
              store.reserve({
                identifier,
                now: at(minutes),
                expiresAt: at(minutes + ttlMinutes),
              });
            assert.equal(yield* reserve("promote:u1", 0, 5), true);
            assert.equal(yield* reserve("promote:u1", 4, 5), false);
            assert.equal(yield* reserve("promote:u1", 5, 5), true);
            assert.equal(yield* reserve("zero", 0, 0), true);
            assert.equal(yield* reserve("zero", 0, 0), true);
          }),
        },
      ],
      race: [
        {
          name: "reserve under concurrency: exactly one of 8 claims of one identifier is true (BEH-EA-063)",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            const results = yield* race(
              store.reserve({
                identifier: "promote:race",
                now: at(0),
                expiresAt: at(5),
              }),
            );
            assert.equal(results.filter((granted) => granted).length, 1);
          }),
        },
      ],
    },
    deleteByUser: {
      write: [
        {
          name: "deleteByUser sweeps the user's tokens, consumed ones included, and nobody else's",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            yield* store.upsertLive(newToken("t1", "verify-email:u1", "h1", { userId: "u1" }));
            yield* store.upsertLive(newToken("t2", "reset-password:u1", "h2", { userId: "u1" }));
            yield* store.upsertLive(newToken("t3", "verify-email:u2", "h3", { userId: "u2" }));
            assert.equal((yield* present("verify-email:u1", "h1"))._tag, "Hit");
            assert.equal(yield* store.deleteByUser(makeUserId("u1")), 2);
            assert.equal((yield* present("reset-password:u1", "h2"))._tag, "Miss");
            assert.equal((yield* present("verify-email:u2", "h3"))._tag, "Hit");
          }),
        },
      ],
    },
    purgeExpired: {
      write: [
        {
          name: "purgeExpired removes consumed tokens, expired tokens and expired reservations, and keeps a live token",
          run: Effect.gen(function* () {
            const store = yield* VerificationStore.VerificationStore;
            yield* store.upsertLive(newToken("t1", "consumed", "h1", { ttlMinutes: 600 }));
            yield* store.upsertLive(newToken("t2", "expired", "h2", { ttlMinutes: 5 }));
            yield* store.upsertLive(newToken("t3", "live", "h3", { ttlMinutes: 600 }));
            assert.equal((yield* present("consumed", "h1", 1))._tag, "Hit");
            yield* store.reserve({
              identifier: "r-old",
              now: at(0),
              expiresAt: at(5),
            });
            yield* store.reserve({
              identifier: "r-live",
              now: at(0),
              expiresAt: at(600),
            });
            // The consumed row, the expired token and the expired reservation go; nothing else.
            assert.equal(yield* store.purgeExpired(at(30)), 3);
            assert.equal((yield* present("live", "h3", 31))._tag, "Hit");
            assert.equal(
              yield* store.reserve({
                identifier: "r-live",
                now: at(31),
                expiresAt: at(40),
              }),
              false,
            );
            assert.equal(yield* store.purgeExpired(at(30)), 0);
          }),
        },
      ],
    },
  },
});
