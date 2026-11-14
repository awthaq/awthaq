// Plan 25 ticket 18 (ADR-EA-041 decision 9): `ChallengeStore`'s contract, run on memory, SQL (Postgres under
// `pnpm test:pg`) and `layerCookie` (an extra adapter in `Contract.test.ts`), a fresh store per case. BEH-EA-132.
// WPS-009: `guarantees` states what a backend really promises, and the cases enforce each property iff claimed:
// `layerMemory`/`layerSql` claim single use and replace-on-issue; the stateless `layerCookie` claims neither, so its
// values stay valid (and replayable) until their TTL.
import { RecordsContract, TestSql } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ChallengeStore from "../../src/ChallengeStore.ts";

export const challengeStore = RecordsContract.suite(ChallengeStore.ChallengeStore, {
  operations: {
    issue: {
      atomic: [
        {
          name: "a fresh challenge each call",
          run: Effect.gen(function* () {
            const store = yield* ChallengeStore.ChallengeStore;
            const a = yield* store.issue("registration:user-1");
            const b = yield* store.issue("registration:user-1");
            assert.notStrictEqual(Redacted.value(a), Redacted.value(b));
          }),
        },
        {
          name: "WPS-009: issuing twice invalidates the first value (iff the store claims replacesPriorOnIssue)",
          run: Effect.gen(function* () {
            const store = yield* ChallengeStore.ChallengeStore;
            const scope = "registration:wps-009-replace";
            const first = yield* store.issue(scope);
            yield* store.issue(scope);
            const firstOk = yield* store.consume(scope, Redacted.value(first));
            // Without server-side state a prior value stays valid until its TTL.
            assert.strictEqual(firstOk, !store.guarantees.replacesPriorOnIssue);
          }),
        },
        {
          name: "WPS-005: an expired, never-consumed challenge is reclaimed by the next issue",
          run: Effect.gen(function* () {
            const store = yield* ChallengeStore.ChallengeStore;
            yield* store.issue("passkey.authenticate:abandoned");
            yield* TestClock.adjust(Duration.minutes(6));
            yield* store.issue("passkey.authenticate:fresh");
            // Nothing expired is left for an explicit sweep to find.
            assert.strictEqual(yield* store.sweepExpired, 0);
          }),
        },
        {
          name: "WPS-005: an issue leaves live challenges alone while reclaiming expired ones",
          run: Effect.gen(function* () {
            const store = yield* ChallengeStore.ChallengeStore;
            yield* store.issue("passkey.authenticate:old-1");
            yield* store.issue("passkey.authenticate:old-2");
            yield* TestClock.adjust(Duration.minutes(6));
            const live = yield* store.issue("passkey.authenticate:live");
            assert.strictEqual(yield* store.sweepExpired, 0);
            assert.isTrue(yield* store.consume("passkey.authenticate:live", Redacted.value(live)));
          }),
        },
      ],
      race: [
        {
          name: "ADR-EA-016: 8 concurrent issues for one scope leave one live challenge (iff replacesPriorOnIssue)",
          run: Effect.gen(function* () {
            const store = yield* ChallengeStore.ChallengeStore;
            yield* RecordsContract.race(store.issue("registration:concurrent"));
            yield* TestClock.adjust(Duration.minutes(6));
            // A stateless store keeps nothing to sweep.
            assert.strictEqual(
              yield* store.sweepExpired,
              store.guarantees.replacesPriorOnIssue ? 1 : 0,
            );
          }),
        },
      ],
    },
    consume: {
      atomic: [
        {
          name: "true for the exact challenge just issued for that scope",
          run: Effect.gen(function* () {
            const store = yield* ChallengeStore.ChallengeStore;
            const scope = "registration:user-2";
            const challenge = yield* store.issue(scope);
            assert.isTrue(yield* store.consume(scope, Redacted.value(challenge)));
          }),
        },
        {
          name: "false for any other value, a tampered one included",
          run: Effect.gen(function* () {
            const store = yield* ChallengeStore.ChallengeStore;
            yield* store.issue("registration:user-3");
            assert.isFalse(yield* store.consume("registration:user-3", "not-the-right-value"));
            const scope = "registration:tamper";
            const issued = Redacted.value(yield* store.issue(scope));
            // Change the FIRST character: all six of its bits are significant, so the decoded bytes
            // always differ. The last base64url character carries unused bits that decoding drops,
            // so changing it can yield the very same challenge.
            const tampered = `${issued[0] === "A" ? "B" : "A"}${issued.slice(1)}`;
            assert.isFalse(yield* store.consume(scope, tampered));
          }),
        },
        {
          name: "two scopes' challenges do not interfere; a value presented against the wrong scope is false",
          run: Effect.gen(function* () {
            const store = yield* ChallengeStore.ChallengeStore;
            yield* store.issue("registration:user-a");
            const b = yield* store.issue("registration:user-b");
            assert.isFalse(yield* store.consume("registration:user-a", Redacted.value(b)));
            assert.isTrue(yield* store.consume("registration:user-b", Redacted.value(b)));
          }),
        },
        {
          name: "an unconsumed challenge expires after five minutes",
          run: Effect.gen(function* () {
            const store = yield* ChallengeStore.ChallengeStore;
            const scope = "registration:user-4";
            const challenge = yield* store.issue(scope);
            yield* TestClock.adjust(Duration.minutes(6));
            assert.isFalse(yield* store.consume(scope, Redacted.value(challenge)));
          }),
        },
        {
          name: "BPAS-008: a non-base64url presented value is false",
          run: Effect.gen(function* () {
            const store = yield* ChallengeStore.ChallengeStore;
            const scope = "registration:bpas-008-garbage";
            yield* store.issue(scope);
            assert.isFalse(yield* store.consume(scope, "!!! not base64url !!!"));
          }),
        },
        {
          name: "BPAS-008: a same-length value differing in its first byte is false",
          run: Effect.gen(function* () {
            const store = yield* ChallengeStore.ChallengeStore;
            const scope = "registration:bpas-008-first-byte";
            const challenge = Redacted.value(yield* store.issue(scope));
            // The last base64url character carries padding bits, so changing only it can decode to the same bytes.
            const first = challenge.slice(0, 1) === "A" ? "B" : "A";
            assert.isFalse(yield* store.consume(scope, `${first}${challenge.slice(1)}`));
          }),
        },
        {
          name: "BEH-EA-132/WPS-009: a consumed value cannot be consumed again (iff the store claims singleUse)",
          run: Effect.gen(function* () {
            const store = yield* ChallengeStore.ChallengeStore;
            const scope = "registration:wps-009-single-use";
            const challenge = yield* store.issue(scope);
            assert.isTrue(yield* store.consume(scope, Redacted.value(challenge)));
            assert.strictEqual(
              yield* store.consume(scope, Redacted.value(challenge)),
              !store.guarantees.singleUse,
            );
          }),
        },
        {
          name: "BEH-EA-132: a wrong value spends the challenge, so the right one is then false (iff singleUse)",
          run: Effect.gen(function* () {
            const store = yield* ChallengeStore.ChallengeStore;
            const scope = "registration:wrong-then-right";
            const challenge = yield* store.issue(scope);
            assert.isFalse(yield* store.consume(scope, "definitely-wrong"));
            assert.strictEqual(
              yield* store.consume(scope, Redacted.value(challenge)),
              !store.guarantees.singleUse,
            );
          }),
        },
      ],
      race: [
        {
          name: "BEH-EA-132: 8 concurrent consumes of one value: exactly one true (iff singleUse; else all 8)",
          run: Effect.gen(function* () {
            const store = yield* ChallengeStore.ChallengeStore;
            const scope = "registration:consume-race";
            const challenge = Redacted.value(yield* store.issue(scope));
            const answers = yield* RecordsContract.race(store.consume(scope, challenge));
            assert.strictEqual(
              answers.filter(Boolean).length,
              store.guarantees.singleUse ? 1 : RecordsContract.CONCURRENCY,
            );
          }),
        },
      ],
    },
    sweepExpired: {
      write: [
        {
          name: "WPS-005: removes expired entries with no intervening issue (none for a stateless store)",
          run: Effect.gen(function* () {
            const store = yield* ChallengeStore.ChallengeStore;
            yield* store.issue("passkey.authenticate:sweep-1");
            yield* store.issue("passkey.authenticate:sweep-2");
            yield* TestClock.adjust(Duration.minutes(6));
            assert.strictEqual(yield* store.sweepExpired, store.guarantees.singleUse ? 2 : 0);
            assert.strictEqual(yield* store.sweepExpired, 0);
          }),
        },
      ],
    },
  },
  sql: [
    {
      name: "WPS-009: layerSql claims single use and replace-on-issue",
      run: Effect.gen(function* () {
        const store = yield* ChallengeStore.ChallengeStore;
        assert.deepStrictEqual(store.guarantees, { singleUse: true, replacesPriorOnIssue: true });
      }),
    },
    {
      name: "ADR-EA-016: two concurrent issues for one scope never leave two rows behind",
      run: Effect.gen(function* () {
        const store = yield* ChallengeStore.ChallengeStore;
        const sql = yield* SqlClient.SqlClient;
        const scope = "registration:concurrent-sql";
        yield* Effect.all([store.issue(scope), store.issue(scope)], { concurrency: "unbounded" });
        // Consuming with the losing value would also delete the winner's row (BEH-EA-132), so count rows.
        const rows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) as count FROM passkey_challenge WHERE scope = ${scope}
        `;
        assert.strictEqual(Number(rows[0]?.count), 1); // pg returns COUNT as bigint
      }),
    },
    {
      name: "plan 05: a store outage on issue is StoreUnavailable naming ChallengeStore.issue",
      run: Effect.gen(function* () {
        yield* TestSql.injectFailure({
          name: "passkey_challenge_fail_insert",
          table: "passkey_challenge",
          event: "INSERT",
        });
        const store = yield* ChallengeStore.ChallengeStore;
        const failure = yield* Effect.flip(store.issue("outage-scope"));
        assert.strictEqual(failure._tag, "StoreUnavailable");
        assert.strictEqual(failure.operation, "ChallengeStore.issue");
      }),
    },
  ],
});
