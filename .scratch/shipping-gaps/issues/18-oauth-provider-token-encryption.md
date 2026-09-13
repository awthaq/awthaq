# 18 — Provider-token encryption at rest

**What to build:** OAuth provider access/refresh tokens are encrypted
before being persisted and decrypted transparently on read — a database
dump no longer contains usable third-party credentials.

**Blocked by:** 17

**Status:** ready-for-agent

- [ ] A dedicated encryption service (not a bare `Model.Sensitive`
      transform) wraps AES-256-GCM using the key-provider port from
      ticket 17
- [ ] AAD binds ciphertext to both the provider id and the user id of the
      row it belongs to
- [ ] Encrypted values carry a `kid` so a future key rotation doesn't
      require synchronous re-encryption of existing rows
- [ ] `packages/sql`'s `accessToken`/`refreshToken` columns are encrypted
      before write and decrypted on read, transparently to existing
      callers
- [ ] Round-trip test: a token encrypted then decrypted equals the
      original; a test asserts the raw persisted bytes are demonstrably
      not the plaintext
- [ ] Existing OAuth plugin tests pass unmodified in external behavior
