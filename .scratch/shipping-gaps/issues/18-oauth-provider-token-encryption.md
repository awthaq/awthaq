# 18 — Provider-token encryption at rest

**What to build:** OAuth provider access/refresh tokens are encrypted
before being persisted and decrypted transparently on read — a database
dump no longer contains usable third-party credentials.

**Blocked by:** 17

**Status:** done

## Result

New `@effect-auth/ports/Encryption`: a fixed AES-256-GCM envelope
(`encrypt(plaintext, aad) => Effect<string>` /
`decrypt(envelope, aad) => Effect<Redacted<string>, DecryptionFailed |
UnknownKeyId>`) wrapping the swappable `KeyProvider` port from ticket 17
— the same "fixed algorithm over a swappable store" shape
`RateLimiter.layer` already has over `RateLimiterStore` in this same
package. Uses the platform WebCrypto (`globalThis.crypto.subtle`), not
Node's `node:crypto` module — matching `@effect-auth/jwt`'s
`KeyRing.ts`/`JwtCodec.ts` and `@effect-auth/oauth`'s `Jwt.ts`'s own
existing choice for their own signing/verification. The envelope is a
single opaque base64url-encoded JSON string (`{v, kid, iv, ciphertext}`
— WebCrypto's own AES-GCM output already has the auth tag appended, so
no separate tag field is needed), so it fits in a single TEXT column
*and* (ticket 19's own future use) a cookie value without any format
change. `aad` (additional authenticated data) is caller-supplied and
unencrypted-but-authenticated — decrypting with a different `aad` than
was used to encrypt fails closed with `DecryptionFailed`, which is how
ticket 18's own "AAD binds ciphertext to the row it belongs to"
requirement is enforced.

Placed in `@effect-auth/ports` rather than `@effect-auth/core`: both
`@effect-auth/sql` (this ticket's own consumer) and `@effect-auth/oauth`
(ticket 19's) already depend on `ports`; neither depends on `core`, and
`core` depends on `sql` — so `core` would have been the wrong direction
entirely. This also directly fulfills spec.md's own requirement that the
service be "callable from both the SQL persistence path and the
cookie/flow-payload path, not just one."

`packages/sql/src/Repositories.ts`'s `AccountsRepositoryLive` now wraps
`insert`/`update`/`findById`/`findByProviderSubject`/`listByUser`:
`accessToken`/`refreshToken` are encrypted before every write and
decrypted after every read, entirely transparent to
`AccountsRepositoryShape`'s own interface (unchanged — still the same
plain nullable strings `Model.Sensitive` already types them as). AAD is
`${providerId}:${userId}:${field}` — binds a ciphertext to its row *and*
its specific column, so an access-token ciphertext copied into the
refresh-token column of the very same row also fails to decrypt, not
just a cross-row swap. `update`'s AAD needs `providerId`/`userId`, which
aren't part of the update payload itself (`Model.FieldExcept`-excluded,
immutable once linked) — resolved with one `repo.findById` lookup before
re-encrypting, mirroring the existing `Accounts.layerSql.updateCredentialHash`
pattern in `@effect-auth/core` that already reads the row first for the
same reason.

**A real gap this ticket's own investigation surfaced, noted rather than
silently expanded around:** despite spec.md's problem statement claiming
OAuth provider tokens "are persisted in plaintext" today, they are
actually never persisted at all — `Accounts.layerSql.link` in
`@effect-auth/core` has always written `accessToken: null,
refreshToken: null` unconditionally, `AccountsShape.link`'s own input
type has no token fields, and `OAuth.ts`'s `exchangeCode` doesn't even
extract `refresh_token` from the provider's token response. This was
inherited from the original (already-stale) comparison report's
inaccurate claim, not verified against current `main` before spec.md was
written. Deliberately **not** expanded here: actually wiring OAuth
token capture (extending `exchangeCode`, threading real tokens through
the three `accounts.link` call sites in `OAuth.ts`'s callback handler) is
a distinct, real feature — not what this ticket's own acceptance
criteria ask for, which are specifically about the encryption mechanism
on `packages/sql`'s columns. Building that mechanism, and proving it
transparent and correct via the SQL repository layer directly (which is
fully testable independent of whether any caller currently populates
real token values), is what this ticket delivers; capturing real tokens
is a clearly-scoped follow-up this Result flags rather than either
silently doing or silently ignoring.

New tests: `packages/ports/test/Encryption.test.ts` (6) — round-trip,
envelope never contains the plaintext as a literal substring, wrong-AAD
failure, tampered-ciphertext failure, malformed-envelope failure,
unknown-`kid` failure. `packages/sql/test/Repositories.test.ts` gained
one new test: a real `accessToken`/`refreshToken` round-trips through
`insert`/`findById` unchanged, while a raw `SELECT` against the
underlying SQLite table proves the persisted bytes are demonstrably not
the plaintext (this ticket's own explicit acceptance criterion).
Existing Accounts-repository tests (BEH-EA-034, BEH-EA-043,
BEH-EA-045/047, `Accounts.test.ts`'s `layerSql` suite) all pass
unmodified in external behavior — only their layer composition grew an
`Encryption` provider, the same ripple every prior ticket's new
dependency has caused.

Ripple: `AccountsRepositoryLive`'s signature grew `Encryption.Encryption`
in its requirements — `packages/sql/test/Repositories.test.ts`,
`Repositories.postgres.test.ts`, and `packages/core/test/Accounts.test.ts`
(its `SqlTestLayer`) all needed a test `EncryptionLive` (env-backed
`KeyProvider.layerEnv` under a `ConfigProvider.fromEnv` isolated from the
real `process.env`, plus `NodeCrypto.layer`) added to their compositions.
`packages/sql` gained `@effect/platform-node` as a devDependency (needed
by its own test files' `NodeCrypto.layer`, already a devDependency
elsewhere in this monorepo).

`pnpm test` — 584 passed, 2 skipped (was 577; +6 Encryption contract
tests, +1 SQL round-trip test); `pnpm typecheck`/`pnpm lint`/`pnpm
format:check` clean workspace-wide.

- [x] A dedicated encryption service (not a bare `Model.Sensitive`
      transform) wraps AES-256-GCM using the key-provider port from
      ticket 17
- [x] AAD binds ciphertext to both the provider id and the user id of the
      row it belongs to
- [x] Encrypted values carry a `kid` so a future key rotation doesn't
      require synchronous re-encryption of existing rows
- [x] `packages/sql`'s `accessToken`/`refreshToken` columns are encrypted
      before write and decrypted on read, transparently to existing
      callers
- [x] Round-trip test: a token encrypted then decrypted equals the
      original; a test asserts the raw persisted bytes are demonstrably
      not the plaintext
- [x] Existing OAuth plugin tests pass unmodified in external behavior
