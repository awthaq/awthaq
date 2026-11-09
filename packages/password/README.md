# @awthaq/password

The Password plugin: `sign-up`, `sign-in`, `request-reset` / `confirm-reset`, `verify-email` / `resend-verification`, `change-email` / `change-email/confirm` (a mailed, verified address change), `change-password` and `reauthenticate`, with argon2id/scrypt hashing (rehash-on-login), rate limiting, an optional HIBP breach check and transactional reset confirmation. Mounted under the shared `"auth"` id, group `"password"`.

Requires the ports it names (`PasswordHasher`, `Mailer`, `RateLimiter`, `SqlTransaction`, ...) — the application provides them.

See [`spec/behaviors/15-password.md`](../../spec/behaviors/15-password.md) (BEH-EA-113–120, 345) and [`spec/appendices/01-password-signup-to-session-view.md`](../../spec/appendices/01-password-signup-to-session-view.md).

## The password credential (`PasswordCredential`)

`Password.layer` exposes `PasswordCredential` (key `awthaq/plugin/password/Credential`, [ADR-EA-048](../../spec/decisions/048-password-credential-module.md)): the one module that reads or writes a user's password credential or runs the `PasswordHasher` on it. Every endpoint of this plugin goes through it, and so do the trusted callers outside it: `@awthaq/admin`'s `AdminAccounts` (which lists `Password` in `dependsOn`) and `awthaq seed admin` (which reads it from the application context). A plugin of your own reaches it the same way, by listing `Password` in `dependsOn` and requiring the service.

```ts
const credential = yield* PasswordCredential.PasswordCredential;
// Every password goes through `accept` first: Password.config's policy in force for the calling
// fiber's tenant (minimum length, breach screening). It is a network call: never inside a unit.
const password = yield* credential.accept(candidate); // fails PasswordApi.WeakPassword { hints }
yield* sqlTransaction.withTransaction(
  credential.set(userId, password), // replace, or link one if there is none; fails only StoreUnavailable
);
```

- **Brands.** `set`, `replace` and `linkFor` take only an `Accepted`, which only `accept` mints, so no password is written without the policy. `rehashIfStale` takes only the `Proof` a successful `verify` returned.
- **`verify(claimant, candidate)`** resolves the claimant effect, reads its credential and runs exactly one real verify (against a boot-time dummy hash when there is none), the whole thing held to `signInTimingFloor`; it answers `Refused` or `Verified { claimant, proof }` and never says which refusal applied.
- **`replace`** rewrites an existing credential and answers `false` (computing no hash) when there is none; **`has`** says whether there is one; **`linkFor`** hashes an accepted password for a sign-up unit.
- A write hashes at most once, inside the caller's unit, only once a write is certain; a store outage is `StoreUnavailable`, never a defect.
- Operator imports (`awthaq import`, `@awthaq/migrate-*`) store a foreign hash and are the one exemption.

A host whose layer type is emitted in a declaration file (`declaration: true`) names the exposed service, or TypeScript reports TS2883: `export type PasswordServices = PasswordCredential.PasswordCredential`, as `examples/memory-server` and `examples/sql-server` do.

## Native clients

A mobile or CLI app has no cookie jar it can read. Send `X-Awthaq-Token-Delivery: bearer` on `sign-up`, `sign-in` or `change-password` and the response carries the session token in its `token` field and sets no cookie; present it afterwards as `Authorization: Bearer <token>`. The same token also comes back in the `set-auth-token` response header, as does a rotated one (`changePassword` replaces the token: follow the header, or the next request presents the superseded token and revokes every session). Without the header nothing changes: the `__Host-session` cookie is set and the body has no token. Any other header value answers `400 InvalidTokenDelivery` before an account or session is created. Where the token lives on the device (Keychain, Keystore) is the app's job; this library ships the wire contract only. `@awthaq/client`'s `bearerTransformClient` sends the header and stores the token for you.

The first mutating call still goes through CSRF protection because it has no `Authorization` header yet: fetch the `__Host-csrf` cookie and echo it in `x-csrf-token` (later calls carry `Authorization` and are exempt).
