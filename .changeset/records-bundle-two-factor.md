---
"@awthaq/two-factor": minor
---

`TwoFactor.records` is the plugin's record stores as one matched `{ memory, sql }` bundle, and the stores' service keys gain the `/records/` segment.

- `TwoFactorSecrets` and `TwoFactorRecoveryCodes` are keyed `awthaq/two-factor/records/<Name>`; the bundle provides both over memory and over SQL, and `AuthPlugin.layer` refuses a layer that requires a store the bundle does not provide. The `MemoryEnvelopes` test seam of `layerSecretsMemory` is not part of the bundle.
- `SecondFactor.layer` is NOT absorbed into `TwoFactor.layer`: the two gates a host provides (`sessionGate`, `credentialResetGate`) sit beneath the plugin and require `SecondFactor` themselves, so they would have nothing to read it from. A host keeps providing it, beneath the gates.

Migration: code that built a `Context` by the old key string must use the class. A host replaces `Layer.mergeAll(TwoFactorStore.layerSecretsMemory, TwoFactorStore.layerRecoveryCodesMemory)` (or the SQL pair) with `TwoFactor.records.memory` / `TwoFactor.records.sql`.
