# @awthaq/two-factor

The TOTP two-factor plugin: enrolment (`/two-factor/enable`, `/confirm`), the sign-in challenge (`/two-factor/verify`), single-use recovery codes (`/verify-recovery`, `/recovery-codes/regenerate`), `/two-factor/status` and `/two-factor/disable`. RFC 6238 codes (HMAC-SHA1 over `Crypto`, six digits, thirty-second steps, one step of drift), a replay guard on the last accepted step, secrets encrypted at rest through the `Encryption` port (AAD `two_factor_secret:<userId>`, lazy re-encryption on key rotation), recovery codes hashed with `PasswordHasher`. Mounted under the shared `"auth"` id, group `"twoFactor"`.

See [`spec/behaviors/28-two-factor.md`](../../spec/behaviors/28-two-factor.md) (BEH-EA-233–239), [ADR-EA-020](../../spec/decisions/020-two-factor-state.md) and [ADR-EA-021](../../spec/decisions/021-sms-otp-restricted-plugin.md).

## Composition is fail-closed

A second factor that a sign-in path silently skips is worse than none, so the plugin's layer _requires_ two marker services and you cannot forget them: omitting either is a compile error.

```ts
import { TwoFactor, SecondFactor, TwoFactorStore } from "@awthaq/two-factor";

const Auth = Auth.make([Password, TwoFactor.TwoFactor]);

const layer = Layer.mergeAll(Password.layer, TwoFactor.TwoFactor.layer).pipe(
  Layer.provideMerge(TwoFactor.sessionGate), // taps BeforeSessionIssue: diverts every first-factor sign-in
  Layer.provideMerge(TwoFactor.credentialResetGate), // taps BeforeCredentialReset: password reset asks for the factor too
  Layer.provideMerge(SecondFactor.layer),
  Layer.provideMerge(TwoFactorStore.layerSecretsSql), // or ...Memory
  Layer.provideMerge(TwoFactorStore.layerRecoveryCodesSql), // or ...Memory
);
```

- `sessionGate` makes a first-factor sign-in (password, magic link, email OTP, ...) return `TwoFactorRequired { challenge }` for a user with a confirmed second factor; the session is minted only after the challenge is proved. `bypassStrategies` (default none) exempts a strategy such as `passkey`, which is already multi-factor.
- `credentialResetGate` makes `Password.confirmReset` require a valid second-factor code for an enrolled user, checked inside the reset's transaction. An application with no credential reset provides `TwoFactor.noCredentialReset` to opt out explicitly.

Requires `Encryption`, `PasswordHasher`, `RateLimiter` and the core services. Configure with `TwoFactorConfig.config({ issuer: "Acme", ... })`; the defaults follow RFC 6238.

## Lockout

Wrong codes spend one per-account failure budget across every method and challenge (default 5 in 15 minutes; a success does not reset it). The guard uses `RateLimiter.check` before the code is evaluated and `consume` only on a failure, so an attacker cannot drain a budget by guessing correctly and a locked account answers before any hashing.

## Data

Two tables (`two_factor_secret`, `two_factor_recovery_code`), created by the plugin's own migrations. Both are contributed to erasure and to the data export (`twoFactorErasure`, `twoFactorExport`); the export lists factor status and the count of unspent recovery codes, never a secret or a hash.
