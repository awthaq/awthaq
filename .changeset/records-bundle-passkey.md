---
"@awthaq/passkey": minor
---

`Passkey.records` is the plugin's credential, user-handle and challenge stores as one matched `{ memory, sql }` bundle, and the stores' service keys gain the `/records/` segment.

- `PasskeyCredentials`, `PasskeyUserHandles` and `ChallengeStore` are keyed `awthaq/passkey/records/<Name>`; the bundle provides all three over memory and over SQL, and `AuthPlugin.layer` refuses a layer that requires a store the bundle does not provide. `WebAuthn` stays a port the host provides (tests mock it).

Migration: code that built a `Context` by the old key string must use the class. A host replaces the three `layerMemory` / `layerSql` layers with `Passkey.records.memory` / `Passkey.records.sql`.
