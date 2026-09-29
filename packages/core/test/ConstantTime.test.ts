// TSS-003: the shared constant-time comparison's contract — equal, different,
// and different-length operands all answer correctly (the timing property
// itself is structural: no early return on a mismatch).
import { assert, describe, it } from "@effect/vitest";
import * as ConstantTime from "../src/ConstantTime.ts";

const bytes = (...values: ReadonlyArray<number>): Uint8Array => Uint8Array.from(values);

describe("ConstantTime", () => {
  it("equal byte strings compare equal", () => {
    assert.isTrue(ConstantTime.constantTimeEqual(bytes(1, 2, 3), bytes(1, 2, 3)));
    assert.isTrue(ConstantTime.constantTimeEqual(bytes(), bytes()));
  });

  it("byte strings differing in one position compare unequal, wherever it is", () => {
    assert.isFalse(ConstantTime.constantTimeEqual(bytes(9, 2, 3), bytes(1, 2, 3)));
    assert.isFalse(ConstantTime.constantTimeEqual(bytes(1, 2, 9), bytes(1, 2, 3)));
  });

  it("different-length inputs compare unequal, including a prefix of the other", () => {
    assert.isFalse(ConstantTime.constantTimeEqual(bytes(1, 2), bytes(1, 2, 3)));
    assert.isFalse(ConstantTime.constantTimeEqual(bytes(1, 2, 3), bytes(1, 2)));
    assert.isFalse(ConstantTime.constantTimeEqual(bytes(), bytes(0)));
  });

  it("strings compare by their UTF-8 bytes", () => {
    assert.isTrue(ConstantTime.constantTimeEqualString("état-9", "état-9"));
    assert.isFalse(ConstantTime.constantTimeEqualString("état-9", "etat-9"));
    assert.isFalse(ConstantTime.constantTimeEqualString("abc", "abcd"));
  });
});
