// THS-001 step 9/5, TTE-008 (BEH-EA-234, INV-EA-005): the guarantees the type system carries. These are
// compile-time checks — `tsc -p tsconfig.test.json` is the assertion — with a token runtime test so
// the file is a suite.
import { Users } from "@awthaq/core";
import { it } from "@effect/vitest";
import type * as Layer from "effect/Layer";
import * as Challenge from "../src/Challenge.ts";
import * as TwoFactor from "../src/TwoFactor.ts";

type Includes<Haystack, Needle> = [Needle] extends [Haystack] ? true : false;

// Omitting a gate is a compile error: the plugin layer *requires* the markers, and only a gate provides them.
type PluginNeeds = Layer.Services<typeof TwoFactor.TwoFactor.layer>;
export const pluginRequiresTheSessionGate: Includes<PluginNeeds, TwoFactor.TwoFactorGateInstalled> =
  true;
export const pluginRequiresAResetGuard: Includes<PluginNeeds, TwoFactor.TwoFactorResetGuard> = true;

// ...and each gate is what provides its marker (and nothing forces a cycle back through the plugin).
type SessionGateGives = Layer.Success<typeof TwoFactor.sessionGate>;
type ResetGateGives = Layer.Success<typeof TwoFactor.credentialResetGate>;
type NoResetGives = Layer.Success<typeof TwoFactor.noCredentialReset>;
export const sessionGateProvidesItsMarker: Includes<
  SessionGateGives,
  TwoFactor.TwoFactorGateInstalled
> = true;
export const resetGateProvidesItsGuard: Includes<ResetGateGives, TwoFactor.TwoFactorResetGuard> =
  true;
export const noCredentialResetProvidesTheGuard: Includes<
  NoResetGives,
  TwoFactor.TwoFactorResetGuard
> = true;
export const sessionGateDoesNotRequireThePlugin: Includes<
  Layer.Services<typeof TwoFactor.sessionGate>,
  typeof TwoFactor.TwoFactor
> = false;

// A session can only follow a verified second factor: `verified` accepts a spent challenge and a
// `FactorProof` (branded, minted only by `SecondFactor.check*`), so a bare object is refused.
const consumed: Challenge.ConsumedChallenge = {
  userId: Users.UserId("u-1"),
  strategy: "password",
  amr: ["pwd"],
  attempt: 0,
};

export const cannotForgeAProof = () =>
  // @ts-expect-error - a plain `{ userId, method }` is not a `FactorProof`; only SecondFactor mints one
  Challenge.verified(consumed, { userId: Users.UserId("u-1"), method: "totp" });

// An unverified (merely consumed) challenge is not a `VerifiedChallenge`.
export const consumedIsNotVerified = (challenge: Challenge.ConsumedChallenge) => {
  // @ts-expect-error - a ConsumedChallenge lacks the brand and the method
  const verifiedChallenge: Challenge.VerifiedChallenge = challenge;
  return verifiedChallenge;
};

it("the guarantees above are checked by the compiler", () => {});
