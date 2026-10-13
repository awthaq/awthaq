---
"@awthaq/two-factor": minor
---

The TOTP secret is a sealed column, and every store failure is `StoreUnavailable` (plan 05).

- `SecretRecord.secret` is `SealedColumn.Sealed<string>` (was `envelope: string`); `TwoFactorSecrets.upsertPending` takes the base32 secret as a `Redacted` and seals it under `two_factor_secret:<userId>:secret`. The earlier `two_factor_secret:<userId>` AAD still opens, and a secret written under a retired encryption key re-seals, both by compare-and-swap on read; `TwoFactorSecrets.reencrypt` and the manual re-encryption in `SecondFactor` are removed. A secret that does not open is still the fail-closed `TwoFactorSecretUnreadable`-class defect, now `sealedColumn.readable` (`SealedColumn.orDie`).
- `layerSecretsMemory/layerSecretsSql` require `Encryption` (`SecondFactor` no longer does); `MemoryEnvelopes` is the memory adapter's test seam. Every `TwoFactorSecrets`, `TwoFactorRecoveryCodes`, `SecondFactor` and `TwoFactor` method fails with `StoreUnavailable` instead of dying; the credential-reset gate, whose hook point can only abort, still turns an outage into a defect that rolls the reset back.

Migration: pass a `Redacted` secret to `upsertPending`; open `record.secret` with `SealedColumn.orDie(record.secret.open)`; provide `Encryption` to the secrets layers; handle `StoreUnavailable` on the widened methods; run `SealedColumn.sweep` on `two_factor_secret.secret` to finish re-sealing secrets that are never read. BEH-EA-263.
