---
"@awthaq/password": minor
---

`PasswordCredential` (exposed by `Password.layer`, ADR-EA-040, key `awthaq/plugin/password/Credential`) is the one module that verifies a password against the stored credential: `verify` resolves the claimant, reads its password credential and runs exactly one real verify (against the boot-time dummy hash when there is none), the whole effect held to the timing floor in force; `rehashIfStale` upgrades the credential on the branded `Proof` only `verify` mints. `signIn` goes through it.

Migration: none in the API. `Password.config`, `Password.PasswordConfig` and `Password.PasswordConfigShape` are unchanged; they now live in `PasswordConfig.ts` and are re-exported. A host whose layer type is emitted names the exposed `PasswordCredential.PasswordCredential` like any other exposed service.
