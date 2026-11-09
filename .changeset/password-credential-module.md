---
"@awthaq/password": minor
"@awthaq/test": patch
---

`PasswordCredential` (exposed by `Password.layer`, ADR-EA-040, key `awthaq/plugin/password/Credential`) is the one module that verifies a password against the stored credential: `verify` resolves the claimant, reads its password credential and runs exactly one real verify (against the boot-time dummy hash when there is none), the whole effect held to the timing floor in force; `rehashIfStale` upgrades the credential on the branded `Proof` only `verify` mints. `accept` is the one policy (minimum length, breach screening, per-tenant overrides) and mints the branded `Accepted` every write takes; `linkFor` hashes an accepted password for the sign-up unit; `set` replaces or links the credential and `replace` rewrites an existing one, never linking one (both inside the caller's unit of work, the KDF at most once and only once a write is certain), and `has` answers whether there is one. Sign-up, reset and change accept through it; `signIn`, `changePassword` and `reauthenticate` verify through it, so the timing floor now covers the account lookup of the last two as well as their verify. `changePassword` now commits the new hash, the revocation of the caller's other sessions and the rotated session as one unit, and its transaction failing is `StoreUnavailable` (503).

`@awthaq/test`: `StoreContract.accounts` gains the case "insertIfAbsent that loses a race inside an enclosing transaction leaves it usable"; its cases now require `SqlTransaction` (the `Ref` runner provides `SqlTransaction.layerNoop`).

Migration: none in the API. `Password.config`, `Password.PasswordConfig` and `Password.PasswordConfigShape` are unchanged; they now live in `PasswordConfig.ts` and are re-exported. A host whose layer type is emitted in a declaration file must name the exposed service, or TypeScript reports TS2883: add `export type PasswordServices = PasswordCredential.PasswordCredential` beside the layer, as the examples do.
