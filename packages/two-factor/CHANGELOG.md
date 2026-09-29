# @awthaq/two-factor

## 0.2.0

### Minor Changes

- Add TOTP two-factor authentication (`@awthaq/two-factor`), passwordless sign-in by a POST-only magic link and a six-digit email code (`@awthaq/magic-link`), and session authentication assurance. Verification can mint numeric values with a per-token attempt budget; sessions record RFC 8176 `amr`, which reaches qadi policies and principal JWTs (`amr`, `auth_time`); `Hooks.BeforeCredentialReset` lets a second factor guard password reset; an opt-in admin layer notifies the owner when impersonation starts.
  
  Migration:
  
  - `RateLimiter.of(...)` implementations must now provide `check` (a read-only peek; `layerPermissive` is a no-op). BEH-EA-266, ADR-EA-020.
  - `VerificationRepository.upsertLive` and the `VerificationToken` model gain `maxAttempts` and `attempts`; run core migration 28. BEH-EA-271.
  - `Sessions.AuthMethod` gains `"sms"`; `UserPrincipal` gains `authenticatedAt`. Exhaustive matches over either must handle the new member. BEH-EA-258.
  - `Password.confirmReset` consults `Hooks.BeforeCredentialReset` and answers `SecondFactorRequired` (401) for a user with a confirmed second factor when `secondFactorCode` is missing; composing `@awthaq/two-factor` requires `TwoFactor.sessionGate` and either `TwoFactor.credentialResetGate` or `TwoFactor.noCredentialReset`. BEH-EA-259, BEH-EA-261.
  - `AdminAccounts.setUserPassword` now consults `Hooks.BeforeCredentialReset` (with no second-factor code) and can fail with `HookAborted` (403); for a user protected by `@awthaq/two-factor` an administrator can no longer silently replace the password. BEH-EA-259.

### Patch Changes

- 3514b28: The OAuth 2.0 device authorization grant (RFC 8628) ships as `@awthaq/device-authorization`, and `awthaq login` uses it (DAG-002, DAG-004, DAG-005; BEH-EA-299 to BEH-EA-307).
  
  - `@awthaq/device-authorization`: `POST /device/code` and `POST /device/token` (the polling states `authorization_pending`, `slow_down`, `access_denied`, `expired_token`, at-most-once redemption), `POST /device/verify` / `approve` / `deny` for the page a signed-in user approves on, public clients from configuration or an operator's `registerClient`, hashed user and device codes, per-address, per-session and per-client rate limits, a `BeforeDeviceApproval` veto, erasure and export contributions, and `purgeExpired`. The minted session is an ordinary bearer session carrying the approving session's `amr`. Tables `device_authorization_grant` and `device_authorization_client` (append-only migrations); Postgres-tested.
  - `@awthaq/cli`: `awthaq login` without a token runs the device flow (a code and URL on stderr, a browser opened unless `--no-browser`, polling with +5 seconds on every `slow_down`); `--client-id` names the client (default `awthaq-cli`, which the plugin registers by default). A server without the plugin exits 9 naming it; a denied or expired request exits 8. `--token` and `AWTHAQ_TOKEN` are unchanged.
  - `@awthaq/core`: two audit events, `auth.deviceAuthorization.approved` and `.denied`.
  - `@awthaq/two-factor`: the session gate no longer diverts an `amr` that already records `mfa` (only this plugin's own completed challenge writes it), so a device approved from a session that proved a second factor is not asked again.
  - `@awthaq/api`: `Api.BackChannel`, an annotation for credential-in-the-request endpoints called by non-browser clients (`apikey.token`, the device `code`/`token` pair): they deliberately carry no `CsrfProtection`, and `awthaq doctor` no longer flags them as unprotected mutating endpoints (`@awthaq/api-key` annotates its token group).
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
