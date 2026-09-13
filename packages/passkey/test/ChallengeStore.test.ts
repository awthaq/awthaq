// spec/behaviors/17-passkey.md, BEH-EA-132.
//
// The same contract suite runs against `layerMemory` and `layerSql` — the
// same pattern `packages/core/test/Verification.test.ts` uses for its own
// two `Layer`s. `layerCookie` runs a *reduced* variant of the suite: its
// own header comment documents why strict single-use cannot be a property
// of a genuinely stateless design, so that one assertion is replaced with
// a test that states the actual, weaker guarantee explicitly rather than
// silently skip it.
import { NodeCrypto } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { SqlClient } from "effect/unstable/sql";
import { ChallengeStore } from "../src/index.ts";

const MemoryLayer = ChallengeStore.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE passkey_challenge (
        scope TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        createdAt TEXT NOT NULL
      )
    `;
  }),
).pipe(Layer.provide(SqlLive));

const SqlLayer = ChallengeStore.layerSql.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const CookieLayer = ChallengeStore.layerCookie.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provide(
    Layer.succeed(ChallengeStore.ChallengeCookieConfig, {
      secret: Redacted.make("test-only-challenge-cookie-secret"),
    }),
  ),
);

const suite = (
  name: string,
  layer: Layer.Layer<ChallengeStore.ChallengeStore, unknown, never>,
): void => {
  describe(name, () => {
    it.effect("issue returns a fresh challenge each call", () =>
      Effect.gen(function* () {
        const store = yield* ChallengeStore.ChallengeStore;
        const a = yield* store.issue("registration:user-1");
        const b = yield* store.issue("registration:user-1");
        assert.notStrictEqual(Redacted.value(a), Redacted.value(b));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("consume succeeds for the exact challenge just issued for that scope", () =>
      Effect.gen(function* () {
        const store = yield* ChallengeStore.ChallengeStore;
        const scope = "registration:user-2";
        const challenge = yield* store.issue(scope);
        const ok = yield* store.consume(scope, Redacted.value(challenge));
        assert.isTrue(ok);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("consume fails for any other value", () =>
      Effect.gen(function* () {
        const store = yield* ChallengeStore.ChallengeStore;
        const scope = "registration:user-3";
        yield* store.issue(scope);
        const ok = yield* store.consume(scope, "not-the-right-value");
        assert.isFalse(ok);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("two different scopes' challenges don't interfere with each other", () =>
      Effect.gen(function* () {
        const store = yield* ChallengeStore.ChallengeStore;
        const a = yield* store.issue("registration:user-a");
        const b = yield* store.issue("registration:user-b");
        const crossed = yield* store.consume("registration:user-a", Redacted.value(b));
        assert.isFalse(crossed);
        const correct = yield* store.consume("registration:user-b", Redacted.value(b));
        assert.isTrue(correct);
        void a;
      }).pipe(Effect.provide(layer)),
    );

    it.effect("an unconsumed challenge expires after five minutes", () =>
      Effect.gen(function* () {
        const store = yield* ChallengeStore.ChallengeStore;
        const scope = "registration:user-4";
        const challenge = yield* store.issue(scope);
        yield* TestClock.adjust(Duration.minutes(6));
        const ok = yield* store.consume(scope, Redacted.value(challenge));
        assert.isFalse(ok);
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("ChallengeStore (layerMemory)", MemoryLayer);
suite("ChallengeStore (layerSql)", SqlLayer);

describe("ChallengeStore (layerMemory) — single-use", () => {
  it.effect(
    "BEH-EA-132: a challenge is deleted after consume — a second consume with the same value fails",
    () =>
      Effect.gen(function* () {
        const store = yield* ChallengeStore.ChallengeStore;
        const scope = "registration:single-use-memory";
        const challenge = yield* store.issue(scope);
        const first = yield* store.consume(scope, Redacted.value(challenge));
        const replay = yield* store.consume(scope, Redacted.value(challenge));
        assert.isTrue(first);
        assert.isFalse(replay);
      }).pipe(Effect.provide(MemoryLayer)),
  );

  it.effect(
    "BEH-EA-132: consuming with the WRONG value still deletes the entry — a later consume with the right value fails too",
    () =>
      Effect.gen(function* () {
        const store = yield* ChallengeStore.ChallengeStore;
        const scope = "registration:wrong-then-right-memory";
        const challenge = yield* store.issue(scope);
        const wrong = yield* store.consume(scope, "definitely-wrong");
        const right = yield* store.consume(scope, Redacted.value(challenge));
        assert.isFalse(wrong);
        assert.isFalse(right);
      }).pipe(Effect.provide(MemoryLayer)),
  );
});

describe("ChallengeStore (layerSql) — single-use", () => {
  it.effect(
    "BEH-EA-132: a challenge is deleted after consume — a second consume with the same value fails",
    () =>
      Effect.gen(function* () {
        const store = yield* ChallengeStore.ChallengeStore;
        const scope = "registration:single-use-sql";
        const challenge = yield* store.issue(scope);
        const first = yield* store.consume(scope, Redacted.value(challenge));
        const replay = yield* store.consume(scope, Redacted.value(challenge));
        assert.isTrue(first);
        assert.isFalse(replay);
      }).pipe(Effect.provide(SqlLayer)),
  );

  it.effect(
    "ADR-EA-016: two concurrent issues for the same scope never leave two live rows behind",
    () =>
      Effect.gen(function* () {
        const store = yield* ChallengeStore.ChallengeStore;
        const sql = yield* SqlClient.SqlClient;
        const scope = "registration:concurrent-sql";
        yield* Effect.all([store.issue(scope), store.issue(scope)], {
          concurrency: "unbounded",
        });
        // BEH-EA-132's own "deleted on every attempt, regardless of
        // outcome" means consuming with the *losing* value here would also
        // destroy the row the *winning* value would have matched — so this
        // checks the row count directly (ADR-EA-016's actual claim: one
        // atomic upsert, never two concurrent rows) rather than trying both
        // values through `consume` the way `Verification.test.ts`'s
        // differently-shaped (match-conditional) `tryConsume` can.
        const rows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) as count FROM passkey_challenge WHERE scope = ${scope}
        `;
        assert.strictEqual(rows[0]?.count, 1);
      }).pipe(Effect.provide(SqlLayer)),
  );
});

describe("ChallengeStore (layerCookie)", () => {
  it.effect(
    "issue produces a self-verifying value; consume validates it against the same scope",
    () =>
      Effect.gen(function* () {
        const store = yield* ChallengeStore.ChallengeStore;
        const scope = "registration:cookie-user";
        const challenge = yield* store.issue(scope);
        const ok = yield* store.consume(scope, Redacted.value(challenge));
        assert.isTrue(ok);
      }).pipe(Effect.provide(CookieLayer)),
  );

  it.effect("consume rejects a tampered or forged value", () =>
    Effect.gen(function* () {
      const store = yield* ChallengeStore.ChallengeStore;
      const scope = "registration:cookie-tamper";
      const challenge = yield* store.issue(scope);
      const tampered = `${Redacted.value(challenge).slice(0, -2)}xx`;
      const ok = yield* store.consume(scope, tampered);
      assert.isFalse(ok);
    }).pipe(Effect.provide(CookieLayer)),
  );

  it.effect("consume rejects a value presented against the wrong scope", () =>
    Effect.gen(function* () {
      const store = yield* ChallengeStore.ChallengeStore;
      const challenge = yield* store.issue("registration:cookie-scope-a");
      const ok = yield* store.consume("registration:cookie-scope-b", Redacted.value(challenge));
      assert.isFalse(ok);
    }).pipe(Effect.provide(CookieLayer)),
  );

  it.effect("an unconsumed challenge expires after five minutes", () =>
    Effect.gen(function* () {
      const store = yield* ChallengeStore.ChallengeStore;
      const scope = "registration:cookie-expiry";
      const challenge = yield* store.issue(scope);
      yield* TestClock.adjust(Duration.minutes(6));
      const ok = yield* store.consume(scope, Redacted.value(challenge));
      assert.isFalse(ok);
    }).pipe(Effect.provide(CookieLayer)),
  );

  it.effect(
    "documented limitation: unlike layerMemory/layerSql, a still-unexpired value MAY be consumed more than once (no server-side state to mark it used)",
    () =>
      Effect.gen(function* () {
        const store = yield* ChallengeStore.ChallengeStore;
        const scope = "registration:cookie-replay";
        const challenge = yield* store.issue(scope);
        const first = yield* store.consume(scope, Redacted.value(challenge));
        const secondStillWithinTtl = yield* store.consume(scope, Redacted.value(challenge));
        assert.isTrue(first);
        assert.isTrue(secondStillWithinTtl);
      }).pipe(Effect.provide(CookieLayer)),
  );
});
