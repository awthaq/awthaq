// SOS-008: three spellings of one number resolve to one stored value, and
// anything that is not well-formed E.164 never becomes an `E164`.
import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Phone from "../src/Phone.ts";

const us = { defaultCountryCode: "1" } as const;

describe("Phone.normalizePhone (SOS-008)", () => {
  it("'+1 555 0100', '15550100' (default region US) and '+15550100' normalize identically", () => {
    const spellings = [
      Phone.normalizePhone("+1 555 0100"),
      Phone.normalizePhone("1-555-0100", us),
      Phone.normalizePhone("+15550100"),
      Phone.normalizePhone("(1) 555.0100", us),
      Phone.normalizePhone("0015550100"),
    ];
    for (const spelling of spellings) assert.deepStrictEqual(spelling, Option.some("+15550100"));
  });

  it("a national number gets the default country code; a trunk 0 is dropped", () => {
    assert.deepStrictEqual(
      Phone.normalizePhone("020 7946 0958", { defaultCountryCode: "44" }),
      Option.some("+442079460958"),
    );
    assert.deepStrictEqual(Phone.normalizePhone("5550100", us), Option.some("+15550100"));
  });

  it("without a `+`/`00` prefix and no default country code, input is refused", () => {
    assert.isTrue(Option.isNone(Phone.normalizePhone("5550100")));
  });

  it("refuses letters, empty input, a leading-zero country code and over-long numbers", () => {
    for (const bad of [
      "",
      "+",
      "call me",
      "+0 555 0100",
      "+1234567890123456",
      "+1",
      "++15550100",
    ]) {
      assert.isTrue(Option.isNone(Phone.normalizePhone(bad, us)), `expected ${bad} to be refused`);
    }
  });

  it("the E164 schema decodes only the canonical form", () => {
    assert.isTrue(Option.isSome(Schema.decodeUnknownOption(Phone.E164)("+15550100")));
    assert.isTrue(Option.isNone(Schema.decodeUnknownOption(Phone.E164)("15550100")));
    assert.isTrue(Option.isNone(Schema.decodeUnknownOption(Phone.E164)("+1 555 0100")));
  });
});
