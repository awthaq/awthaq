---
"@awthaq/two-factor": minor
"@awthaq/magic-link": minor
"@awthaq/core": minor
"@awthaq/ports": minor
"@awthaq/sql": minor
"@awthaq/password": minor
"@awthaq/api": minor
"@awthaq/passkey": minor
"@awthaq/jwt": minor
"@awthaq/qadi": minor
"@awthaq/roles": minor
"@awthaq/admin": minor
---

Add TOTP two-factor authentication (`@awthaq/two-factor`), passwordless sign-in by a POST-only magic link and a six-digit email code (`@awthaq/magic-link`), and session authentication assurance. Verification can mint numeric values with a per-token attempt budget; sessions record RFC 8176 `amr`, which reaches qadi policies and principal JWTs (`amr`, `auth_time`); `Hooks.BeforeCredentialReset` lets a second factor guard password reset; an opt-in admin layer notifies the owner when impersonation starts.

Migration:

- `RateLimiter.of(...)` implementations must now provide `check` (a read-only peek; `layerPermissive` is a no-op). BEH-EA-263, ADR-EA-020.
- `VerificationRepository.upsertLive` and the `VerificationToken` model gain `maxAttempts` and `attempts`; run core migration 28. BEH-EA-268.
- `Sessions.AuthMethod` gains `"sms"`; `UserPrincipal` gains `authenticatedAt`. Exhaustive matches over either must handle the new member. BEH-EA-255.
- `Password.confirmReset` consults `Hooks.BeforeCredentialReset` and answers `SecondFactorRequired` (401) for a user with a confirmed second factor when `secondFactorCode` is missing; composing `@awthaq/two-factor` requires `TwoFactor.sessionGate` and either `TwoFactor.credentialResetGate` or `TwoFactor.noCredentialReset`. BEH-EA-256, BEH-EA-258.
