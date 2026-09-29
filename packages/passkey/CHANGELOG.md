# @awthaq/passkey

## 0.2.0

### Minor Changes

- Add TOTP two-factor authentication (`@awthaq/two-factor`), passwordless sign-in by a POST-only magic link and a six-digit email code (`@awthaq/magic-link`), and session authentication assurance. Verification can mint numeric values with a per-token attempt budget; sessions record RFC 8176 `amr`, which reaches qadi policies and principal JWTs (`amr`, `auth_time`); `Hooks.BeforeCredentialReset` lets a second factor guard password reset; an opt-in admin layer notifies the owner when impersonation starts.
  
  Migration:
  
  - `RateLimiter.of(...)` implementations must now provide `check` (a read-only peek; `layerPermissive` is a no-op). BEH-EA-266, ADR-EA-020.
  - `VerificationRepository.upsertLive` and the `VerificationToken` model gain `maxAttempts` and `attempts`; run core migration 28. BEH-EA-271.
  - `Sessions.AuthMethod` gains `"sms"`; `UserPrincipal` gains `authenticatedAt`. Exhaustive matches over either must handle the new member. BEH-EA-258.
  - `Password.confirmReset` consults `Hooks.BeforeCredentialReset` and answers `SecondFactorRequired` (401) for a user with a confirmed second factor when `secondFactorCode` is missing; composing `@awthaq/two-factor` requires `TwoFactor.sessionGate` and either `TwoFactor.credentialResetGate` or `TwoFactor.noCredentialReset`. BEH-EA-259, BEH-EA-261.
  - `AdminAccounts.setUserPassword` now consults `Hooks.BeforeCredentialReset` (with no second-factor code) and can fail with `HookAborted` (403); for a user protected by `@awthaq/two-factor` an administrator can no longer silently replace the password. BEH-EA-259.
- 4cd6174: A bounded session-rotation grace window, an `SmsSender` port with an E.164 rate-limit key, and passkey Related Origin Requests.
  
  - **Rotation grace (RRS-005, RRC-006).** The secret a throttled touch replaces keeps verifying for `SessionConfig.rotationGrace` (default 30 seconds, `Duration.zero` disables it). Presenting it inside the window succeeds, re-rotates and hands back a fresh secret in `rotated`, so a lost `Set-Cookie` or `set-auth-token` no longer strands the client; it is per session, never a reuse signal (no family revocation, no `auth.session.reuse`), and `auth.session.rotated` carries `viaGrace` for those recoveries. New sessions columns `previousSecretHash`/`previousSecretExpiresAt` (core migration 29); `SessionsRepository.touch` takes them (optional).
  - **`SmsSender` port (SOS-002).** `@awthaq/ports` exports `SmsSender` (`send`/`sent`, `layerNoop`/`layerMemory`/`layerConsole`, a typed `SmsDeliveryFailed`), mirroring `Mailer`. `RateLimits.phoneKey(read, options?)` (SOS-007) is a key strategy that normalises the destination to E.164 first, so an SMS endpoint gets a per-recipient cap alongside `"ip"` and `"principal"`.
  - **Related Origin Requests (TC-008).** `PasskeyConfig.relatedOrigins` (default `[]`) lists exact https origins outside `rpId` that may use its passkeys; every ceremony accepts them and a new anonymous `GET /.well-known/webauthn` (group `passkey.wellKnown`) serves the list (404 while empty).
  
  Migration: a deployment that relied on the replaced session secret dying instantly sets `SessionConfig.rotationGrace: Duration.zero`. Apply core migration 29 (two nullable columns). A hand-built `Sessions` table in tests needs `previousSecretHash TEXT, previousSecretExpiresAt TEXT`. `Auth.make([Passkey])` lists a fifth group, `passkey.wellKnown`. BEH-EA-052, BEH-EA-133.

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
  - @awthaq/sql@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/server@0.1.0
  - @awthaq/sql@0.1.0
