// @awthaq/two-factor — TwoFactorConfig
//
// THS-001 step 4 (BEH-EA-17/ADR-EA-011): the policy knobs, a `Context.Reference` with a default,
// overridden by `TwoFactor.config({...})`. The defaults are what RFC 6238 and every authenticator
// app assume (six digits, thirty-second steps, one step of drift either side) plus ticket 05's
// challenge and recovery-code parameters.

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";

export interface TwoFactorConfigShape {
  /** The label an authenticator app shows above the account name. Set it to your product's name. */
  readonly issuer: string;
  /** Digits per code. RFC 4226 allows 6 to 8; authenticator apps default to 6 and some ignore other values. */
  readonly digits: number;
  /** Seconds per time step. */
  readonly period: number;
  /** Steps accepted either side of the current one (clock drift, typing time). RFC 6238 §5.2 suggests 1. */
  readonly window: number;
  /** BEH-EA-259: how long the challenge a divert mints stays valid (single-use). */
  readonly challengeTtl: Duration.Duration;
  /** Wrong codes one sign-in may try before the client must restart it: each wrong code re-issues a fresh challenge until this many have been spent. */
  readonly maxAttemptsPerChallenge: number;
  /** BEH-EA-261: how many recovery codes `confirm` (and `regenerate`) mint. */
  readonly recoveryCodeCount: number;
  /** BEH-EA-261: characters per recovery code, from a 32-symbol unambiguous alphabet (5 bits each — 10 gives 50 bits). */
  readonly recoveryCodeLength: number;
  /** BEH-EA-260: how recent `authenticatedAt` must be to enrol, disable or regenerate. */
  readonly reauthMaxAge: Duration.Duration;
  /**
   * Strategies whose sign-in is not diverted to a second factor — e.g. `["passkey"]`, since a
   * user-verified passkey is already multi-factor. Secure default: none, every strategy diverts.
   */
  readonly bypassStrategies: ReadonlyArray<string>;
  /** BCR-006 (ADR-EA-020): the shared per-account failure budget — this many failures across every method and challenge... */
  readonly failureLimit: number;
  /** ...within this window; success does not reset it. */
  readonly failureWindow: Duration.Duration;
}

const defaults: TwoFactorConfigShape = {
  issuer: "awthaq",
  digits: 6,
  period: 30,
  window: 1,
  challengeTtl: Duration.minutes(10),
  maxAttemptsPerChallenge: 3,
  recoveryCodeCount: 10,
  recoveryCodeLength: 10,
  reauthMaxAge: Duration.minutes(10),
  bypassStrategies: [],
  failureLimit: 5,
  failureWindow: Duration.minutes(15),
};

export const TwoFactorConfig = Context.Reference<TwoFactorConfigShape>("awthaq/two-factor/Config", {
  defaultValue: () => defaults,
});

export const config = (partial: Partial<TwoFactorConfigShape>) =>
  Layer.succeed(TwoFactorConfig, { ...defaults, ...partial });
