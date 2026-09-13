# 03 — Persistent SQL backend & migrations

**Type:** grilling
**Status:** resolved
**Blocked by:** 00

## Question

`packages/sql` is dialect-agnostic repositories with no real driver
behind them; there is no migrations directory or executed migrator
anywhere in the repo (`packages/core/src/Migrations.ts` is scaffold
only). Grounded in ticket 00's survey of what Effect v4 itself actually
offers, decide: (a) which dialect ships first — Postgres is the obvious
choice (matches upstream's own drizzle-pg, matches what most adopters of
an auth library will reach for), but confirm nothing in this repo's prior
research (`research/10-schema-migrations.md`) already committed to
something else. (b) migration tooling — hand-rolled SQL files plus
whatever runner ticket 00 found in `../effect`, versus a third-party tool
(drizzle-kit, atlas, etc.) generating from `packages/sql`'s existing
`Models.ts` schemas; which keeps `packages/sql` dialect-agnostic in
principle while still shipping one real backend? (c) transactional
port — is `withTransaction` a new addition to the existing
`@effect-auth/ports` package (matching how `PasswordHasher`/`Mailer`/
`RateLimiter` are already formalized there), or a capability on the SQL
repositories themselves? Which multi-step flows in this codebase actually
need atomicity today (OAuth account-linking completion is the clearest
candidate, mirroring upstream's own transactional OAuth completion)? (d)
does this ticket's answer also cover `packages/oauth`'s persistence, or
is that intentionally deferred to ticket 04 (encryption) since the two
are related but separable?

## Answer

**Grounding correction, resolved before the design forks below.** An
audit surfaced that dialect strategy is *already settled* architecture,
not open: ADR-EA-004 (`spec/decisions/004-database-neutral-models.md:19`)
commits to dialect-neutral models supporting Postgres/SQLite/MySQL, and
`research/10-schema-migrations.md:95` names Postgres+SQLite as the v1
targets. But decision 016 (`spec/decisions/016-verification-sql-claiming.md:28,34,50`)
found only `@effect/sql-sqlite-node` is actually installed/tested today,
and explicitly rejected designing Postgres now as "speculative" — scoped
narrowly to the verification-claiming primitive that decision covered.

**(a) Dialect — Postgres ships now, explicitly superseding 016's scoping
for this map.** Decision 016's rejection was narrow (one primitive, one
moment in the codebase's history); this map's entire purpose is closing
the "no persistent production backend" gap ADR-EA-004 already committed
to generally, and ticket 00 confirmed a real, ready `@effect/sql-pg`
driver exists — there is nothing speculative left to reject. SQLite
stays as-is, nothing regresses. This supersession gets recorded as its
own follow-up note against ADR-EA-014/016 once implementation lands
(a `/to-tickets` concern, not resolved further here).

**(b) Migration tooling — wire the existing scaffold onto Effect's own
real migrator, no third-party tool.** `packages/core/src/Migrations.ts`'s
scaffold gets built on `effect/unstable/sql`'s `Migrator` (`fromFileSystem`
loader, default `effect_sql_migrations` tracking table, forward-only,
whole-batch-in-one-transaction — per ticket 00's Answer) plus the
Postgres-specific `PgMigrator` wrapper from `@effect/sql-pg`. No
drizzle-kit or equivalent needed.

**(c) Transactional port — new `@effect-auth/ports` addition.** A
`SqlTransaction`-shaped port wrapping `SqlClient.withTransaction` (a
first-class primitive per ticket 00, not hand-rolled), matching the
`PasswordHasher`/`Mailer`/`RateLimiter` convention already established in
that package. First real consumer: OAuth account-linking completion —
the clearest multi-step atomicity need in this codebase today, mirroring
upstream's own transactional OAuth completion.

**(d) OAuth persistence — mechanism here, encryption in ticket 04.** This
ticket covers the transactional/storage mechanism only; the
token-encryption layer that sits on top of it is ticket 04's separate
scope, as originally framed.
