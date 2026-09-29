# @awthaq/password

## 0.2.0

### Minor Changes

- Administrator account deletion and credential changes (`AdminAccounts`), and a mailed change-email flow in the password plugin.
  
  - `@awthaq/admin`: the opt-in `AdminAccounts` plugin (`Auth.make([Admin, AdminAccounts])`, group `admin.accounts`) adds `DELETE /admin/users/:userId` (the one `AccountErasure` cascade), `POST /admin/users/:userId/email` (mails a `change-email` token to the new address; the owner confirms) and `POST /admin/users/:userId/password` (through the `PasswordHasher` port, revoking every session), each behind its own fail-closed predicate (`canDeleteUsers`, `canManageCredentials`) with audited `auth.admin.*` events. `AdminConfig` gains those predicates, `passwordPolicy` and `links.changeEmail`; `@awthaq/ports` is now a dependency.
  - `@awthaq/password`: `POST /change-email` (authenticated) and `POST /change-email/confirm` (public), typed `EmailDeliveryFailed`/`EmailChangeNotSupported`, rate limits per requester, per target inbox and per token, `auth.user.emailChanged`, a notice to the previous address, `PasswordConfig.links.changeEmail`.
  - `@awthaq/core`: `EmailChange` (the shared `change-email` purpose) and the events `auth.user.emailChanged`, `auth.admin.userDeleted`, `auth.admin.userEmailChangeRequested`, `auth.admin.userPasswordSet` (a new `AuthEvent` union member).
  
  Migration: none required (all additive). A host that switches on `AdminAccounts` provides `PasswordHasher`, `Mailer` and `AccountErasure`, and the password plugin must be composed for an admin-requested email change to be confirmed. BEH-EA-221/222/224 (amended), BEH-EA-118.
- cb155d4: Confirming an email change ends every session of the account (BEH-EA-053, REQ-EA-686).
  
  `POST /change-email/confirm` (`Password.confirmEmailChange`) is a public, token-authenticated request, so it has no caller session to rotate. It now calls `Sessions.revokeAll(userId, "emailChanged")` in the same transaction that replaces and verifies the address; `auth.session.revoked` carries the new `SessionRevocationReason` `"emailChanged"`.
  
  Migration: a client that stayed signed in across an email change is signed out when the change is confirmed and signs in again under the new address; an exhaustive `switch` over `SessionRevocationReason` gains an `"emailChanged"` case.
- Add TOTP two-factor authentication (`@awthaq/two-factor`), passwordless sign-in by a POST-only magic link and a six-digit email code (`@awthaq/magic-link`), and session authentication assurance. Verification can mint numeric values with a per-token attempt budget; sessions record RFC 8176 `amr`, which reaches qadi policies and principal JWTs (`amr`, `auth_time`); `Hooks.BeforeCredentialReset` lets a second factor guard password reset; an opt-in admin layer notifies the owner when impersonation starts.
  
  Migration:
  
  - `RateLimiter.of(...)` implementations must now provide `check` (a read-only peek; `layerPermissive` is a no-op). BEH-EA-266, ADR-EA-020.
  - `VerificationRepository.upsertLive` and the `VerificationToken` model gain `maxAttempts` and `attempts`; run core migration 28. BEH-EA-271.
  - `Sessions.AuthMethod` gains `"sms"`; `UserPrincipal` gains `authenticatedAt`. Exhaustive matches over either must handle the new member. BEH-EA-258.
  - `Password.confirmReset` consults `Hooks.BeforeCredentialReset` and answers `SecondFactorRequired` (401) for a user with a confirmed second factor when `secondFactorCode` is missing; composing `@awthaq/two-factor` requires `TwoFactor.sessionGate` and either `TwoFactor.credentialResetGate` or `TwoFactor.noCredentialReset`. BEH-EA-259, BEH-EA-261.
  - `AdminAccounts.setUserPassword` now consults `Hooks.BeforeCredentialReset` (with no second-factor code) and can fail with `HookAborted` (403); for a user protected by `@awthaq/two-factor` an administrator can no longer silently replace the password. BEH-EA-259.

### Patch Changes

- 4688890: Plugins declare their rate-limit rules and required ports statically, and `awthaq plugin list` prints them (PV-241).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `rateLimits` (each rule's `group` is confined to the plugin's own contract groups by the compiler; `AuthPlugin.declareRateLimits`, `RateLimits.registerDeclared` and `RateLimits.declarationDrift` keep the declaration and the registry from drifting) and `AuthPlugin.layer`'s `ports` (port classes that join the layer's `RIn`; a required `.../ports/...` service that is not declared fails to type-check). Both reach `Auth.make(...).manifest` as `rateLimits` and `ports`, and as the class statics `Plugin.rateLimits` / `Plugin.ports`.
  - `@awthaq/cli`: `plugin list --rules` prints the declared rules; `plugin list --graph` now prints each plugin's required ports and where its declared taps sit in each hook chain (BEH-EA-202, BEH-EA-111).
  - Every shipped plugin that requires ports now declares them; password, oauth, passkey, api-key, magic-link (and email-otp) and two-factor declare their rate-limit rules. `@awthaq/api-key` also registers its per-client token budget, which was enforced but not listed.
  
  Migration: a plugin that calls `AuthPlugin.layer` and requires an `@awthaq/ports` service (`Mailer`, `RateLimiter`, `PasswordHasher`, ...) must add `ports: [...]` naming it, or it no longer type-checks (the message lists the missing keys). A hand-built `Manifest` value (a test fixture) needs `rateLimits: []` and `ports: []`. BEH-EA-111, BEH-EA-202.
- Updated dependencies
- Updated dependencies [d7351b7]
- Updated dependencies [8dd72b6]
- Updated dependencies [3514b28]
- Updated dependencies [cb155d4]
- Updated dependencies [f831b6c]
- Updated dependencies [e073887]
- Updated dependencies
- Updated dependencies [4688890]
- Updated dependencies
- Updated dependencies [4cd6174]
- Updated dependencies [5d5b3c6]
- Updated dependencies
  - @awthaq/core@0.2.0
  - @awthaq/server@0.2.0
  - @awthaq/api@0.2.0
  - @awthaq/ports@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/server@0.1.0
  - @awthaq/sql@0.1.0
