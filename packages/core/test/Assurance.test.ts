// SOS-005 / AAPS-006 (BEH-EA-231): the assurance vocabulary derived from a session's `amr`.
import { assert, describe, it } from "@effect/vitest";
import * as Assurance from "../src/Assurance.ts";
import type { AuthMethod } from "../src/Sessions.ts";

const table: ReadonlyArray<{
  readonly amr: ReadonlyArray<AuthMethod>;
  readonly level: Assurance.AssuranceLevel;
  readonly restricted: boolean;
  readonly why: string;
}> = [
  {
    amr: [],
    level: "aal1",
    restricted: false,
    why: "nothing recorded is the floor, never a guess",
  },
  { amr: ["pwd"], level: "aal1", restricted: false, why: "a password alone is one factor" },
  {
    amr: ["fed"],
    level: "aal1",
    restricted: false,
    why: "federation is as strong as the IdP says; awthaq cannot tell",
  },
  {
    amr: ["email"],
    level: "aal1",
    restricted: false,
    why: "mailbox possession alone is one factor",
  },
  {
    amr: ["otp", "email"],
    level: "aal1",
    restricted: false,
    why: "an emailed code is still just the mailbox",
  },
  {
    amr: ["pwd", "otp"],
    level: "aal2",
    restricted: false,
    why: "knowledge plus a one-time password",
  },
  {
    amr: ["pwd", "otp", "mfa"],
    level: "aal2",
    restricted: false,
    why: "the two-factor plugin's own record",
  },
  {
    amr: ["hwk"],
    level: "aal1",
    restricted: false,
    why: "a hardware key without user verification is possession only",
  },
  {
    amr: ["hwk", "user"],
    level: "aal3",
    restricted: false,
    why: "hardware-bound key plus user verification",
  },
  {
    amr: ["swk", "user"],
    level: "aal2",
    restricted: false,
    why: "a synced passkey with user verification is multi-factor but not hardware-bound",
  },
  {
    amr: ["swk"],
    level: "aal1",
    restricted: false,
    why: "a synced key without user verification is possession only",
  },
  { amr: ["sms"], level: "aal1", restricted: true, why: "SMS on its own never raises the level" },
  {
    amr: ["pwd", "sms"],
    level: "aal2",
    restricted: true,
    why: "nominally two factors, flagged restricted (NIST SP 800-63B-4)",
  },
  {
    amr: ["pwd", "hwk", "user"],
    level: "aal3",
    restricted: false,
    why: "extra methods never lower the level",
  },
];

describe("Assurance.assurance (SOS-005)", () => {
  for (const row of table) {
    it(`${JSON.stringify(row.amr)} -> ${row.level}${row.restricted ? " (restricted)" : ""}: ${row.why}`, () => {
      const result = Assurance.assurance(row.amr);
      assert.strictEqual(result.level, row.level);
      assert.strictEqual(result.restricted, row.restricted);
      assert.strictEqual(Assurance.assuranceLevel(row.amr), row.level);
    });
  }

  it("a restricted factor never satisfies an unrestricted requirement", () => {
    assert.isFalse(Assurance.satisfies(["pwd", "sms"], "aal2"));
    assert.isTrue(Assurance.satisfies(["pwd", "sms"], "aal2", { allowRestricted: true }));
    assert.isTrue(Assurance.satisfies(["pwd", "otp"], "aal2"));
    assert.isFalse(Assurance.satisfies(["pwd", "otp"], "aal3"));
    assert.isTrue(Assurance.satisfies(["hwk", "user"], "aal2"));
  });

  it("isRestrictedFactor names exactly the SMS method", () => {
    assert.isTrue(Assurance.isRestrictedFactor("sms"));
    assert.isFalse(Assurance.isRestrictedFactor("otp"));
  });
});
