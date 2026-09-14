# 01 — Quote camelCase columns in the core SQL repositories

**What to build:** every `Sessions`/`Accounts`/`Users`/`Verification`
repository operation in `packages/sql`'s core layer actually works against
a real Postgres database, not just SQLite. Found during
`.scratch/upstream-hardening/map.md`'s own code-review pass: `CoreMigrations.ts`
declares several columns quoted with preserved mixed case on Postgres
(`"userId"`, `"providerId"`, `"createdAt"`, `"updatedAt"`, `"emailVerified"`,
`"consumedAt"`, `"expiresAt"`, `"valueHash"`, and others across the
`users`/`accounts`/`sessions`/`verification_tokens`/`verification_reservations`
tables) — but several hand-written raw SQL queries in the repository layer
reference those same columns unquoted. Postgres folds an unquoted
identifier to lowercase, so an unquoted reference to `userId` looks for a
column literally named `userid`, which doesn't exist; the query fails at
runtime with `column "userid" does not exist`.

SQLite's own identifier resolution is case-insensitive regardless of
quoting, so quoting these consistently (the fix already applied to one
query as part of the upstream-hardening ticket 01/02 work, and confirmed
correct there) is safe and correct on both dialects — no dialect branching
needed, unlike DDL.

Confirmed affected today (by direct read, not exhaustive — re-audit while
fixing): `Users` email-verification update, `Accounts` lookup-by-provider-
subject and lookup/delete-all-by-user, `Sessions`' cursor-paginated
`listByUser` query and its `deleteAllForUserExcept` delete, and
`Verification`'s lookup-by-identifier, its upsert-live `ON CONFLICT`
clause, its `tryConsume` update, and the verification-reservations upsert.

This is scoped to `packages/sql/src/Repositories.ts` only — the one file
with both a real Postgres migration (`CoreMigrations.ts`) and raw SQL
referencing those same columns. Every plugin package with its own raw SQL
(`organization`, `admin`, `jwt`, `passkey`) was checked and confirmed to
have no real Postgres migration of its own yet — only test-only SQLite
DDL — so the mismatch this ticket closes doesn't yet exist for those
tables; adding real Postgres migrations for plugin-owned tables is a
separate, larger, pre-existing gap, not part of this ticket.

**Blocked by:** None — can start immediately

**Status:** done

- [x] Every raw SQL query in `packages/sql/src/Repositories.ts` that
      references a camelCase column quotes it consistently on both
      dialects
- [x] `packages/sql/test/Repositories.test.ts` (SQLite) and
      `packages/sql/test/Repositories.postgres.test.ts` (real Postgres,
      run in CI against the `postgres:16` service `check.yml` already
      provisions) both pass, exercising every repository method this
      ticket touches — not just the ones already covered before this fix
- [x] `pnpm check` is green

## Resolution

Fixed every unquoted camelCase reference in `Repositories.ts`: `Users`'s
`verifyEmail` (`"emailVerified"`/`"updatedAt"`), `Accounts`'s
`findByProviderSubject`/`listByUser`/`deleteAllByUser` (`"providerId"`/
`"userId"`), `Sessions`'s `listByUser` cursor query and
`deleteAllForUserExcept` (`"userId"`/`"createdAt"`), and `Verification`'s
`findByIdentifier`/`upsertLive`/`tryConsume` and the reservations
`claim` upsert (`"valueHash"`/`"expiresAt"`/`"consumedAt"`/`"createdAt"`).
Postgres DDL was the source of truth throughout — every fix mirrors what
`CoreMigrations.ts` already declares.

`Repositories.postgres.test.ts` previously exercised only 2 of these
paths; added one test per repository method this ticket touched (6 new
tests) that would have failed with `column "..." does not exist` against
real Postgres before the fix. Couldn't run them locally (no Docker
daemon available in this environment), but they typecheck cleanly against
the same shapes the existing suite uses, and CI's `check.yml` already
provisions a real `postgres:16` service with `AWTHAQ_POSTGRES_URL` set
for this exact file — they'll run for real there.

SQLite suite (17 tests), full workspace test suite (596 passed), and
`pnpm check` (typecheck, package:smoke, lint, knip, format, circular,
coverage, BDD, spec:verify:strict) are all green.
