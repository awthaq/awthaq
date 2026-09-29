// ESS-006: the shared Email contract schema.
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import * as EmailContract from "../src/Email.ts";

const accepts = (value: string): boolean =>
  Schema.decodeUnknownOption(EmailContract.Email)(value)._tag === "Some";

describe("EmailContract.Email", () => {
  it("accepts ordinary addresses, unchanged", () => {
    expect(accepts("a@b.co")).toBe(true);
    expect(accepts("Ada.Lovelace+tag@Example.COM")).toBe(true);
    expect(Schema.decodeUnknownSync(EmailContract.Email)("Ada@Example.COM")).toBe(
      "Ada@Example.COM",
    );
  });

  it("rejects what is plainly not an address", () => {
    for (const junk of [
      "junk",
      "@b.co",
      "a@b",
      "a@",
      "a@@b.co",
      "a b@c.co",
      "a@b.co ",
      "a@.co",
      "a@b.",
    ]) {
      expect(accepts(junk), junk).toBe(false);
    }
  });

  it("enforces the length limits", () => {
    expect(accepts(`${"a".repeat(64)}@b.co`)).toBe(true);
    expect(accepts(`${"a".repeat(65)}@b.co`)).toBe(false);
    expect(accepts(`a@${"b".repeat(250)}.co`)).toBe(false); // 255 characters
  });
});
