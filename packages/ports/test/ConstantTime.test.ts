// ACS-002: the shared constant-time comparator.
import { assert, describe, it } from "@effect/vitest";
import * as ConstantTime from "../src/ConstantTime.ts";

describe("ConstantTime.equalBytes", () => {
  it("is true only for identical bytes", () => {
    const abc = new Uint8Array([1, 2, 3]);
    assert.isTrue(ConstantTime.equalBytes(abc, new Uint8Array([1, 2, 3])));
    assert.isFalse(ConstantTime.equalBytes(abc, new Uint8Array([1, 2, 4])));
    assert.isFalse(ConstantTime.equalBytes(abc, new Uint8Array([9, 2, 3])));
  });

  it("is false on a length mismatch", () => {
    assert.isFalse(ConstantTime.equalBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2])));
    assert.isTrue(ConstantTime.equalBytes(new Uint8Array(), new Uint8Array()));
  });
});

describe("ConstantTime.equalHex", () => {
  it("is true only for identical strings", () => {
    assert.isTrue(ConstantTime.equalHex("deadbeef", "deadbeef"));
    assert.isFalse(ConstantTime.equalHex("deadbeef", "deadbeee"));
    assert.isFalse(ConstantTime.equalHex("deadbeef", "Deadbeef"));
    assert.isFalse(ConstantTime.equalHex("deadbeef", "deadbee"));
    assert.isTrue(ConstantTime.equalHex("", ""));
  });
});
