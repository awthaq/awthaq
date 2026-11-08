// Plan 25 ticket 20 (ADR-EA-041 decision 9): `RevocationStore`'s contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`, a fresh store per case. TIR-001/TRBS-001/MAPS-002 (BEH-EA-295): a
// `jti`-keyed denylist whose entries expire with the token they deny (lazy expiry on read), purged by retention
// (plan 10 item 6). These cases replace `RevocationStore.test.ts`' bespoke suite.
import { RecordsContract, TestSql } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Scheduler from "effect/Scheduler";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as RevocationStore from "../../src/RevocationStore.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);

/**
 * Racing fibers yield to the scheduler every few steps, so they interleave between a read and a write.
 * (Effect 4.1.2 stalls with a budget below 4.)
 */
const fineGrained = Effect.provideService(Scheduler.MaxOpsBeforeYield, 4);

export const revocationStore = RecordsContract.suite(RevocationStore.RevocationStore, {
  operations: {
    revoke: {
      write: [
        {
          name: "revokes the exact jti only",
          run: Effect.gen(function* () {
            const store = yield* RevocationStore.RevocationStore;
            yield* store.revoke("jti-a", at(3_600_000));
            assert.isTrue(yield* store.isRevoked("jti-a"));
            assert.isFalse(yield* store.isRevoked("jti-b"));
          }),
        },
        {
          name: "revoking a jti again keeps it revoked, and the last expiry written is the one kept",
          run: Effect.gen(function* () {
            const store = yield* RevocationStore.RevocationStore;
            yield* store.revoke("jti-d", at(3_600_000));
            yield* store.revoke("jti-d", at(60_000));
            assert.isTrue(yield* store.isRevoked("jti-d"));
            yield* TestClock.adjust("2 minutes");
            assert.isFalse(yield* store.isRevoked("jti-d"));
          }),
        },
      ],
    },
    isRevoked: {
      read: [
        {
          name: "false for a jti never revoked",
          run: Effect.gen(function* () {
            const store = yield* RevocationStore.RevocationStore;
            assert.isFalse(yield* store.isRevoked("never-revoked"));
          }),
        },
        {
          name: "an entry reads as absent once past its own expiresAt (lazy expiry), exactly at it included",
          run: Effect.gen(function* () {
            const store = yield* RevocationStore.RevocationStore;
            yield* store.revoke("jti-c", at(300_000));
            assert.isTrue(yield* store.isRevoked("jti-c"));
            yield* TestClock.adjust("299 seconds");
            assert.isTrue(yield* store.isRevoked("jti-c"));
            yield* TestClock.adjust("1 second");
            assert.isFalse(yield* store.isRevoked("jti-c"));
          }),
        },
      ],
    },
    purgeExpired: {
      atomic: [
        {
          name: "deletes only the entries not after now and reports how many",
          run: Effect.gen(function* () {
            const store = yield* RevocationStore.RevocationStore;
            yield* store.revoke("short", at(300_000));
            yield* store.revoke("edge", at(3_600_000));
            yield* store.revoke("long", at(7_200_000));
            assert.strictEqual(yield* store.purgeExpired(at(3_600_000)), 2);
            assert.strictEqual(yield* store.purgeExpired(at(3_600_000)), 0);
            assert.isTrue(yield* store.isRevoked("long"));
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent purges delete each expired entry once: the counts sum to the expired entries",
          run: Effect.gen(function* () {
            const store = yield* RevocationStore.RevocationStore;
            for (const jti of ["a", "b", "c", "d", "e"]) yield* store.revoke(jti, at(1_000));
            yield* store.revoke("live", at(9_000_000));
            const counts = yield* RecordsContract.race(store.purgeExpired(at(5_000))).pipe(
              fineGrained,
            );
            assert.strictEqual(
              counts.reduce((sum, count) => sum + count, 0),
              5,
            );
            assert.isTrue(yield* store.isRevoked("live"));
            assert.strictEqual(yield* store.purgeExpired(at(5_000)), 0);
          }),
        },
      ],
    },
  },
  sql: [
    {
      name: "the plugin's migrations create jwt_token_revocation",
      run: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // A working `SELECT` is the proof: a missing table fails the query itself.
        assert.deepStrictEqual(yield* sql`SELECT * FROM jwt_token_revocation`, []);
      }),
    },
    {
      name: "a store outage on revoke is StoreUnavailable naming RevocationStore.revoke",
      run: Effect.gen(function* () {
        yield* TestSql.injectFailure({
          name: "jwt_revocation_fail_insert",
          table: "jwt_token_revocation",
          event: "INSERT",
        });
        const store = yield* RevocationStore.RevocationStore;
        const failure = yield* Effect.flip(store.revoke("jti", at(1_000)));
        assert.strictEqual(failure._tag, "StoreUnavailable");
        assert.strictEqual(failure.operation, "RevocationStore.revoke");
      }),
    },
  ],
});
