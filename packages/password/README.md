# @awthaq/password

The Password plugin: `sign-up`, `sign-in`, `request-reset` / `confirm-reset`, `verify-email` / `resend-verification`, `change-password` and `reauthenticate`, with argon2id/scrypt hashing (rehash-on-login), rate limiting, an optional HIBP breach check and transactional reset confirmation. Mounted under the shared `"auth"` id, group `"password"`.

Requires the ports it names (`PasswordHasher`, `Mailer`, `RateLimiter`, `SqlTransaction`, ...) — the application provides them.

See [`spec/behaviors/15-password.md`](../../spec/behaviors/15-password.md) (BEH-EA-113–120) and [`spec/appendices/01-password-signup-to-session-view.md`](../../spec/appendices/01-password-signup-to-session-view.md).

## Native clients

A mobile or CLI app has no cookie jar it can read. Send `X-Awthaq-Token-Delivery: bearer` on `sign-up`, `sign-in` or `change-password` and the response carries the session token in its `token` field and sets no cookie; present it afterwards as `Authorization: Bearer <token>` (a rotated token comes back in the `set-auth-token` response header). Without the header nothing changes: the `__Host-session` cookie is set and the body has no token. Any other header value answers `400 InvalidTokenDelivery` before an account or session is created. Where the token lives on the device (Keychain, Keystore) is the app's job; this library ships the wire contract only. `@awthaq/client`'s `bearerTransformClient` sends the header and stores the token for you.

The first mutating call still goes through CSRF protection because it has no `Authorization` header yet: fetch the `__Host-csrf` cookie and echo it in `x-csrf-token` (later calls carry `Authorization` and are exempt).
