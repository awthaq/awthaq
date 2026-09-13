# 16 — SqlTransaction port + OAuth account-linking atomicity

**What to build:** A new transactional port exists in
`@effect-auth/ports`, and OAuth account-linking completion uses it — a
failure partway through linking leaves no partial state.

**Blocked by:** 15

**Status:** ready-for-agent

- [ ] New `SqlTransaction` (or equivalently named) port added to
      `@effect-auth/ports`, wrapping `SqlClient.withTransaction`,
      matching the `PasswordHasher`/`Mailer`/`RateLimiter` port
      convention
- [ ] OAuth account-linking completion is rewritten to run inside this
      port instead of separate, non-atomic writes
- [ ] A contract test proves a simulated failure partway through
      account-linking leaves no partial account/link row behind,
      exercised against the real Postgres backend from ticket 15
- [ ] Existing OAuth linking tests still pass unmodified in external
      behavior — same contract, now atomic
