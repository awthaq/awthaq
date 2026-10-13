// Plan 02, phase 3: what only the `Ref` adapter of `VerificationStore` can show. What every adapter
// must do is `StoreContract.verification` (`packages/test/test/StoreContract.*.test.ts`).
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Ids from "../src/Ids.ts";
import * as VerificationStore from "../src/VerificationStore.ts";

const at = (minutes: number) => DateTime.makeUnsafe(1_700_000_000_000 + minutes * 60_000);
const tokenId = Schema.decodeUnknownSync(Ids.VerificationTokenId);
const userId = Schema.decodeUnknownSync(Ids.UserId);

const token = (id: string, identifier: string, hash: string, user?: string) => ({
  id: tokenId(id),
  identifier,
  userId: Option.map(Option.fromNullishOr(user), userId),
  valueHash: hash,
  createdAt: at(0),
  expiresAt: at(10),
  payloadJson: Option.none<string>(),
  maxAttempts: Option.none<number>(),
});

const run = <A, E>(effect: Effect.Effect<A, E, VerificationStore.VerificationStore>) =>
  effect.pipe(Effect.provide(VerificationStore.layerMemory));

describe("VerificationStore (Ref) hold and settle (ADR-EA-039)", () => {
  it.effect("a held claim given back is live again with its attempts as they were", () =>
    run(
      Effect.gen(function* () {
        const store = yield* VerificationStore.VerificationStore;
        yield* store.upsertLive(token("t1", "reset-password:u1", "h1"));
        const claimed = yield* store.present({
          identifier: "reset-password:u1",
          valueHash: "h1",
          now: at(1),
          hold: true,
        });
        assert.equal(claimed._tag, "Hit");
        yield* store.settle(tokenId("t1"), "returned");
        const again = yield* store.present({
          identifier: "reset-password:u1",
          valueHash: "h1",
          now: at(2),
          hold: false,
        });
        assert.equal(again._tag, "Hit");
      }),
    ),
  );

  it.effect("a newer upsertLive wins over a give-back", () =>
    run(
      Effect.gen(function* () {
        const store = yield* VerificationStore.VerificationStore;
        yield* store.upsertLive(token("t1", "reset-password:u1", "old"));
        yield* store.present({
          identifier: "reset-password:u1",
          valueHash: "old",
          now: at(1),
          hold: true,
        });
        yield* store.upsertLive(token("t2", "reset-password:u1", "new"));
        yield* store.settle(tokenId("t1"), "returned");
        const old = yield* store.present({
          identifier: "reset-password:u1",
          valueHash: "old",
          now: at(2),
          hold: false,
        });
        assert.equal(old._tag, "Miss");
      }),
    ),
  );

  it.effect(
    "deleteByUser sweeps a held claim, so a give-back cannot resurrect an erased user's token",
    () =>
      run(
        Effect.gen(function* () {
          const store = yield* VerificationStore.VerificationStore;
          yield* store.upsertLive(token("t1", "reset-password:u1", "h1", "u1"));
          yield* store.present({
            identifier: "reset-password:u1",
            valueHash: "h1",
            now: at(1),
            hold: true,
          });
          yield* store.deleteByUser(userId("u1"));
          yield* store.settle(tokenId("t1"), "returned");
          const again = yield* store.present({
            identifier: "reset-password:u1",
            valueHash: "h1",
            now: at(2),
            hold: false,
          });
          assert.equal(again._tag, "Miss");
        }),
      ),
  );

  it.effect("purgeExpired never removes a held claim", () =>
    run(
      Effect.gen(function* () {
        const store = yield* VerificationStore.VerificationStore;
        yield* store.upsertLive(token("t1", "reset-password:u1", "h1"));
        yield* store.present({
          identifier: "reset-password:u1",
          valueHash: "h1",
          now: at(1),
          hold: true,
        });
        yield* store.purgeExpired(at(1000));
        yield* store.settle(tokenId("t1"), "returned");
        const again = yield* store.present({
          identifier: "reset-password:u1",
          valueHash: "h1",
          now: at(2),
          hold: false,
        });
        assert.equal(again._tag, "Hit");
      }),
    ),
  );
});

// TMS-004: the memory adapter's maps are pruned once they outgrow a threshold, so an attacker-chosen
// identifier cannot grow the process without bound.
describe("VerificationStore (Ref) pruning (TMS-004)", () => {
  it.effect("reserve stays correct once expired reservations are pruned", () =>
    run(
      Effect.gen(function* () {
        const store = yield* VerificationStore.VerificationStore;
        for (let i = 0; i < 10_050; i++) {
          yield* store.reserve({ identifier: `spray:${i}`, now: at(0), expiresAt: at(1) });
        }
        yield* store.reserve({ identifier: "live", now: at(0), expiresAt: at(600) });
        // The prune runs on this call: expired spray reservations go, the live one stays.
        assert.isTrue(
          yield* store.reserve({ identifier: "spray:0", now: at(2), expiresAt: at(3) }),
        );
        assert.isFalse(yield* store.reserve({ identifier: "live", now: at(2), expiresAt: at(3) }));
      }),
    ),
  );
});
