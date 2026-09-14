# DB indexes and a real unique constraint on `users.email`

Type: grilling
Status: resolved

## Question

`packages/sql/src/CoreMigrations.ts:58-143` has zero indexes on
`accounts.userId` and `sessions.userId`, and email uniqueness is enforced
only at the service layer, not as a `users_email_unique` DB constraint —
confirmed by direct read, not just the pasted report.

Decide: whether this ships as a new forward-only migration (consistent
with `shipping-gaps` ticket 03's migrator choice) or folded into
`CoreMigrations.ts`'s existing migration if it hasn't shipped anywhere
yet; the exact index set beyond the two named lookups (e.g. does
`sessions.token`/`secretHash` need an index for the rotation lookup ticket
01 will add?); and how a unique-constraint violation on email surfaces
today at the service layer vs. how it should surface once the DB itself
enforces it (does the service-layer check become redundant, or does it
stay as a friendlier pre-check with the DB constraint as the real
guarantee?).

## Answer

Grounded against `packages/core/src/Users.ts:205-253`, `packages/sql/src/Repositories.ts:126,274-388`,
`packages/core/src/Sessions.ts:227-286,395-456`, and `CoreMigrations.ts`'s
own existing migration 5 (`create_verification_tokens_live_identifier_index`,
already a separate migration from migration 4's table creation).

**The email question is not really open — it's a bug, not a design
choice.** `Users.ts:205-213`'s own header comment already documents the
intended design: "a real database constraint... a `UNIQUE` index on
`lower(email)`", and `layerSql.create` (`Users.ts:220-239`) already has
working code catching `SqlError`'s `UniqueViolation` reason and mapping
it to `EmailAlreadyExists` — the service-layer/DB-layer division this
question asked about was **already decided and already implemented**.
The migration just never created the index the code has been assuming
exists. Concretely: today, against a real Postgres or SQLite database,
`create` would silently accept two users with the same email — the
`UniqueViolation` branch is dead code in practice. This ticket closes
that gap; it doesn't reopen the design.

**Ships as new migrations (7/8/9), not folded into 1/2/3** — even though
nothing has shipped anywhere yet (making either choice equally safe),
this file already has its own precedent for exactly this question:
migration 5 is a separate, later migration from migration 4's table
creation, not folded in. Consistency with that existing pattern wins
over "nothing's shipped, it doesn't matter":

- Migration 7 — `create_users_email_unique_index`:
  `CREATE UNIQUE INDEX users_email_unique ON users (lower(email))`
  (both dialects; SQLite supports expression indexes over built-in
  functions). A functional index over `lower(email)`, not a plain
  `UNIQUE(email)` — belt-and-suspenders alongside the app-level
  `.toLowerCase()` normalization `Users.ts` already does before every
  insert, matching the header comment's own stated design exactly.
- Migration 8 — `create_accounts_user_id_index`:
  `CREATE INDEX accounts_user_id ON accounts("userId")` (pg) /
  `accounts(userId)` (sqlite) — real filter key, confirmed at
  `Repositories.ts:280,283` (`listByUser`, `deleteAllByUser`).
- Migration 9 — `create_sessions_user_id_index`:
  `CREATE INDEX sessions_user_id ON sessions("userId")` (pg) /
  `sessions(userId)` (sqlite) — real filter key, confirmed at
  `Repositories.ts:359-361,367,385-388` (`listByUser`,
  `deleteAllForUserExcept`).

**`sessions.token`/`secretHash` — no index needed.** Confirmed by direct
read of both `verify` implementations (`Sessions.ts:227-286` memory,
`395-456` SQL): the lookup is always by `id` (the SQL primary key,
`repo.findById(id)`), never by `secretHash` — the secret is only compared
in application code *after* the row is already fetched by id. Ticket 01's
rotation design doesn't change this lookup shape at all, so nothing new
is needed here regardless.
