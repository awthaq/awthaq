// TMS-004: the shared eviction the in-memory Sessions/Verification twins use.
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as HashMap from "effect/HashMap";
import * as PruneExpired from "../src/internal/pruneExpired.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);
const expiryOf = (value: { readonly expiresAt: DateTime.Utc }) => value.expiresAt;

describe("pruneExpired (TMS-004)", () => {
  it("drops only entries whose expiry is at or before now", () => {
    const map = HashMap.make(
      ["past", { expiresAt: at(50) }],
      ["exactly-now", { expiresAt: at(100) }],
      ["future", { expiresAt: at(150) }],
    );
    const pruned = PruneExpired.pruneExpired(map, at(100), expiryOf);
    assert.deepStrictEqual(Array.from(HashMap.keys(pruned)), ["future"]);
  });

  it("pruneExpiredAbove leaves a map at or under the threshold untouched", () => {
    const map = HashMap.make(["past", { expiresAt: at(50) }], ["future", { expiresAt: at(150) }]);
    assert.strictEqual(PruneExpired.pruneExpiredAbove(map, at(100), expiryOf, 2), map);
    assert.strictEqual(HashMap.size(PruneExpired.pruneExpiredAbove(map, at(100), expiryOf, 1)), 1);
  });
});
