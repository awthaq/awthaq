# @awthaq/password

The Password plugin: `sign-up`, `sign-in`, `request-reset` / `confirm-reset`, `verify-email` / `resend-verification`, `change-password` and `reauthenticate`, with argon2id/scrypt hashing (rehash-on-login), rate limiting, an optional HIBP breach check and transactional reset confirmation. Mounted under the shared `"auth"` id, group `"password"`.

Requires the ports it names (`PasswordHasher`, `Mailer`, `RateLimiter`, `SqlTransaction`, ...) — the application provides them.

See [`spec/behaviors/15-password.md`](../../spec/behaviors/15-password.md) (BEH-EA-113–120) and [`spec/appendices/01-password-signup-to-session-view.md`](../../spec/appendices/01-password-signup-to-session-view.md).
