// Phase 5 Wave 0 pin P5 (CAT-01, RRC-008): the replica's default table list,
// written against the hand-kept list and green after it is derived from the
// catalogue; never edited after this commit.
import { assert, describe, it } from "@effect/vitest";
import * as LaggingReplica from "../src/LaggingReplica.ts";

describe("LaggingReplica default table list (phase 5 pin P5)", () => {
  it("coreTables is the six replicated core tables, in order", () => {
    const expected: ReadonlyArray<string> = [
      "users",
      "accounts",
      "sessions",
      "verification_tokens",
      "verification_reservations",
      "auth_audit_log",
    ];
    assert.deepStrictEqual([...LaggingReplica.coreTables], expected);
  });
});
