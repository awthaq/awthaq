// Plan 25 ticket 18 (ADR-EA-041 decision 9): `PasskeyUserHandles`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`, a fresh store per case. BEH-EA-130/131, BPAS-003: one random handle per
// user, minted once, the same value ever after, even under concurrent first calls.
import { Users } from "@awthaq/core";
import { RecordsContract } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PasskeyUserHandles from "../../src/PasskeyUserHandles.ts";

const alice = Users.UserId("alice");
const bob = Users.UserId("bob");

export const passkeyUserHandles = RecordsContract.suite(PasskeyUserHandles.PasskeyUserHandles, {
  operations: {
    getOrCreate: {
      atomic: [
        {
          name: "mints once and answers the same handle ever after; another user's differs",
          run: Effect.gen(function* () {
            const handles = yield* PasskeyUserHandles.PasskeyUserHandles;
            const first = yield* handles.getOrCreate(alice);
            assert.match(first, /^[A-Za-z0-9_-]{43}$/);
            assert.strictEqual(yield* handles.getOrCreate(alice), first);
            assert.notStrictEqual(yield* handles.getOrCreate(bob), first);
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent first calls for one user all agree on a single handle",
          run: Effect.gen(function* () {
            const handles = yield* PasskeyUserHandles.PasskeyUserHandles;
            const results = yield* RecordsContract.race(handles.getOrCreate(alice));
            assert.strictEqual(new Set(results).size, 1);
            assert.strictEqual(yield* handles.getOrCreate(alice), results[0]);
          }),
        },
      ],
    },
    deleteByUser: {
      write: [
        {
          name: "forgets the handle (a later one is fresh), leaves other users', and is idempotent",
          run: Effect.gen(function* () {
            const handles = yield* PasskeyUserHandles.PasskeyUserHandles;
            const before = yield* handles.getOrCreate(alice);
            const kept = yield* handles.getOrCreate(bob);
            yield* handles.deleteByUser(alice);
            yield* handles.deleteByUser(alice);
            assert.notStrictEqual(yield* handles.getOrCreate(alice), before);
            assert.strictEqual(yield* handles.getOrCreate(bob), kept);
          }),
        },
      ],
    },
  },
});
