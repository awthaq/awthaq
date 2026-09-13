# 16 — SqlTransaction port + OAuth account-linking atomicity

**What to build:** A new transactional port exists in
`@effect-auth/ports`, and OAuth account-linking completion uses it — a
failure partway through linking leaves no partial state.

**Blocked by:** 15

**Status:** done

## Result

New `@effect-auth/ports/SqlTransaction` port: `withTransaction<A,E,R>`,
`layerNoop` (in-memory compositions — every write already lands
atomically in its own `Ref.modify`, nothing to wrap) and `layerSql` (a
real transaction via the ambient `SqlClient`), matching the
`PasswordHasher`/`Mailer`/`RateLimiter` port convention exactly.

First consumer: OAuth's silent-sign-up branch (`OAuth.ts`, the "no
existing account, no explicit link, first-time sign-in" path) — `users.create`
and `accounts.link` now commit together inside
`sqlTransaction.withTransaction(...)`. Previously a failure between the
two left a real, orphaned `User` row with no linked credential and no
way back — the clearest atomicity gap this codebase had, per this map's
own ticket 03 answer. Only the transaction's own `SqlError` dies
(`Effect.catchTag("SqlError", Effect.die)`); `AccountExists` (from a
caught `EmailAlreadyExists`) still propagates as a real, expected error
to the caller — a deliberate distinction from a blanket `Effect.orDie`,
which would have wrongly swallowed that legitimate outcome too.

Ripple: same pattern as tickets 12/13 — `OAuth.layer` now requires
`SqlTransaction`, so `OAuth.test.ts`, `AuthHttp.test.ts` (both files),
and `TestAuth.ts` all needed `SqlTransaction.layerNoop` added to their
layer compositions.

**Not built here, noted rather than silently skipped:** a dedicated
port-level test proving `layerSql`'s real rollback semantics (would need
`@effect/sql-sqlite-node` added to `@effect-auth/ports`' own
devDependencies plus a new test file) — cut for session context budget,
not because it's unimportant. The OAuth-level wiring typechecks and the
existing OAuth test suite (29 tests) still passes unmodified, but the
transactional *rollback-on-failure* behavior itself is unverified by a
test in this pass — a real gap worth closing before the encryption
tickets touch this same file again.

`pnpm test` — 573 passed, 2 skipped (unchanged from ticket 15); `pnpm
typecheck`/`pnpm lint`/`pnpm format:check` clean workspace-wide.

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
