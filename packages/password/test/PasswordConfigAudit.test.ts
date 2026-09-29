// ECS-008/BEH-EA-229: the policy knobs `doctor` audits. A weak minimum, and — in production only —
// an unscreened or unverified sign-in, each produce their own finding; the defaults produce none.
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Password from "../src/Password.ts";

const descriptor = (() => {
  const [first] = Password.Password.config;
  if (first === undefined) throw new Error("the Password plugin declares no config descriptor");
  return first;
})();

const defaults = Context.get(Context.empty(), Password.PasswordConfig);

const codes = (
  partial: Partial<Password.PasswordConfigShape>,
  environment: { readonly production: boolean },
) =>
  descriptor
    .audit(Context.make(Password.PasswordConfig, { ...defaults, ...partial }), environment)
    .map((finding) => finding.code);

describe("Password config audit (ECS-008)", () => {
  it("the defaults raise nothing", () => {
    assert.deepStrictEqual(codes({}, { production: true }), []);
  });

  it("a minimum length under 8 is a warning in any environment", () => {
    assert.deepStrictEqual(codes({ minLength: 4 }, { production: false }), ["password-min-length"]);
  });

  it("an unscreened or unverified sign-in is flagged in production only", () => {
    const weak = { breachCheck: false, requireVerifiedEmail: false };
    assert.deepStrictEqual(codes(weak, { production: true }), [
      "password-breach-check-off",
      "password-unverified-sign-in",
    ]);
    assert.deepStrictEqual(codes(weak, { production: false }), []);
  });
});
