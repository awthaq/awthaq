// @awthaq/two-factor — TOTP two-factor authentication (M7)
//
// TOTP (RFC 6238) with hashed single-use recovery codes, attached to the sign-in divert point
// (`Hooks.BeforeSessionIssue`) and the credential-reset veto (`Hooks.BeforeCredentialReset`).
// See `README.md` for the composition recipe, `spec/behaviors/28-two-factor.md` for the behaviors
// and `spec/decisions/020-two-factor-state.md` for the state decisions.
//
//   import { TwoFactor } from "@awthaq/two-factor";
//   TwoFactor.TwoFactor            // the plugin class (`Auth.make([Password, TwoFactor.TwoFactor])`)
//   TwoFactor.sessionGate          // taps BeforeSessionIssue — required
//   TwoFactor.credentialResetGate  // taps BeforeCredentialReset — required (or `noCredentialReset`)
//   SecondFactor.layer             // the domain service both build on

export * as Challenge from "./Challenge.ts";
export * as RecoveryCodes from "./RecoveryCodes.ts";
export * as SecondFactor from "./SecondFactor.ts";
export * as Totp from "./Totp.ts";
export * as TwoFactor from "./TwoFactor.ts";
export * as TwoFactorApi from "./TwoFactorApi.ts";
export * as TwoFactorConfig from "./TwoFactorConfig.ts";
export * as TwoFactorStore from "./TwoFactorStore.ts";
