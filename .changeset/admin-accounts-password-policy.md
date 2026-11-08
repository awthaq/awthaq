---
"@awthaq/admin": minor
---

`AdminAccounts` lists `Password` in `dependsOn` (ADR-EA-048): an administrator-set password goes through `Password`'s exposed `PasswordCredential`, so it passes `Password.config`'s policy in force for the request's tenant (minimum length, breach screening with its `onUnavailable` posture, per-tenant overrides) before anything is written, and `AdminWeakPassword` may now carry `"appears in known breaches"`. The credential is replaced, or linked for a user who had none, inside the same transaction that revokes the user's sessions; `AdminAccounts` no longer requires the `PasswordHasher` port. `AdminConfig.passwordPolicy` is removed.

Migration: compose `Auth.make([Admin, Password, AdminAccounts])` (a tuple without `Password` no longer compiles) and provide the `HttpClient` the breach check uses, or set `Password.config({ breachCheck: false })` to opt out of screening. Move a custom `passwordPolicy` to `Password.config({ minLength, breachCheck })`, per tenant if needed; an administrator-only extra rule is no longer supported. An administrator's password hash is now computed inside the transaction.
