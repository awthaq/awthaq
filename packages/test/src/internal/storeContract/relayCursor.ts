// @awthaq/test — the relayCursor suite of StoreContract (plan 37)
import assert from "node:assert/strict";
import { RelayCursorStore } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CONCURRENCY } from "../contract.ts";
import { at } from "./fixtures.ts";
import { suite } from "./suite.ts";

/** The `RelayCursorStore` contract (plan 23, ADR-EA-030 decision 4, ADR-EA-041): a monotonic, per-name position. */
export const relayCursor = suite(RelayCursorStore.RelayCursorStore, {
  operations: {
    get: {
      read: [
        {
          name: "get is None for a name that was never advanced",
          run: Effect.gen(function* () {
            const store = yield* RelayCursorStore.RelayCursorStore;
            assert.equal(Option.isNone(yield* store.get("relay")), true);
          }),
        },
      ],
    },
    advance: {
      atomic: [
        {
          name: "advance stores the first position, and a later id replaces it",
          run: Effect.gen(function* () {
            const store = yield* RelayCursorStore.RelayCursorStore;
            yield* store.advance({
              name: "relay",
              lastEventId: "event-1",
              at: at(0),
            });
            assert.deepEqual(yield* store.get("relay"), Option.some("event-1"));
            yield* store.advance({
              name: "relay",
              lastEventId: "event-2",
              at: at(1),
            });
            assert.deepEqual(yield* store.get("relay"), Option.some("event-2"));
          }),
        },
        {
          name: "names are independent: advancing one leaves another untouched",
          run: Effect.gen(function* () {
            const store = yield* RelayCursorStore.RelayCursorStore;
            yield* store.advance({ name: "a", lastEventId: "event-5", at: at(0) });
            yield* store.advance({ name: "b", lastEventId: "event-1", at: at(0) });
            assert.deepEqual(yield* store.get("a"), Option.some("event-5"));
            assert.deepEqual(yield* store.get("b"), Option.some("event-1"));
            assert.equal(Option.isNone(yield* store.get("c")), true);
          }),
        },
        {
          name: "advance never moves a position backwards: an earlier id, or the same id again, changes nothing",
          run: Effect.gen(function* () {
            const store = yield* RelayCursorStore.RelayCursorStore;
            yield* store.advance({
              name: "relay",
              lastEventId: "event-5",
              at: at(0),
            });
            yield* store.advance({
              name: "relay",
              lastEventId: "event-3",
              at: at(1),
            });
            assert.deepEqual(yield* store.get("relay"), Option.some("event-5"));
            yield* store.advance({
              name: "relay",
              lastEventId: "event-5",
              at: at(2),
            });
            assert.deepEqual(yield* store.get("relay"), Option.some("event-5"));
          }),
        },
        {
          name: "advance compares ids as bytes: of two uuidv7-shaped ids differing only in a later hex digit, the larger wins whatever the arrival order",
          run: Effect.gen(function* () {
            const store = yield* RelayCursorStore.RelayCursorStore;
            const low = "01930b5e-7a3c-7d2e-8f41-0123456789ab";
            const high = "01930b5e-7a3c-7d2e-8f41-0123456789ac";
            yield* store.advance({ name: "up", lastEventId: low, at: at(0) });
            yield* store.advance({ name: "up", lastEventId: high, at: at(1) });
            yield* store.advance({ name: "down", lastEventId: high, at: at(0) });
            yield* store.advance({ name: "down", lastEventId: low, at: at(1) });
            assert.deepEqual(yield* store.get("up"), Option.some(high));
            assert.deepEqual(yield* store.get("down"), Option.some(high));
          }),
        },
      ],
      race: [
        {
          name: "advance under concurrency: 8 racing advances of one name leave the largest id",
          run: Effect.gen(function* () {
            const store = yield* RelayCursorStore.RelayCursorStore;
            yield* Effect.all(
              Array.from({ length: CONCURRENCY }, (_, i) =>
                store.advance({
                  name: "relay",
                  lastEventId: `e-${i + 1}`,
                  at: at(i),
                }),
              ),
              { concurrency: "unbounded" },
            );
            assert.deepEqual(yield* store.get("relay"), Option.some(`e-${CONCURRENCY}`));
          }),
        },
      ],
    },
  },
});
