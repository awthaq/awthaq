# Shipping-gap closure — upstream comparison follow-through

## Destination

A spec at `.scratch/shipping-gaps/spec.md` (produced via `/to-spec`,
mirroring `Organization`'s and `Jwt`'s own path rather than `Admin`'s
core-touching one, though one ticket below may yet pull a specific piece
toward a formal `spec/behaviors/` range if it turns out to force a real
core change) covering the **local-only** remediation of the real gaps
identified by `/tmp/effect-auth-compare/full-report.md` (the 50-agent
head-to-head against `EduSantosBrito/effect-auth` v0.5.0) — re-grounded
against this repo's *current* state, not the report's snapshot, since the
report is already measurably stale (see the charting decision below).
Ready to hand to `/to-tickets` once resolved.

In scope, narrowed to what's still actually missing after re-grounding:

1. Fix the stale "pre-implementation" README banner; ship a real quickstart.
2. Close the remaining account-lifecycle HTTP gaps (email verification at
   minimum; audit change-password/update-user/delete-user while at it).
3. Wire the built-but-unconsumed `RateLimitsRegistry` into real plugin
   call sites (and `TestAuth`).
4. Add a persistent SQL backend with real migrations, plus a transactional
   port analogous to upstream's `withTransaction`.
5. Add encryption at rest for OAuth provider tokens (and PKCE
   verifier/nonce) — upstream's AES-256-GCM envelope (ADR 0006) is
   reference material for the *technique*, not code to port; this library
   is not upstream's and implements its own envelope independently.
6. Execute a real slice of the 602 `features/` BDD scenarios in CI (today
   only the smoke scenario runs), and land the governance/release
   scaffolding that's fully absent (LICENSE, CHANGELOG, CONTRIBUTING,
   SECURITY.md; a real publish path off the already-present-but-inert
   `@changesets/cli` config).

**Explicitly out of scope** (see Out of scope below): the 8 stub-package
list from the report — most of which are no longer stubs anyway — and
anything that would mean editing `EduSantosBrito/effect-auth` itself,
which this session's user was explicit is a different, unrelated library.

## Notes

- Domain: `/tmp/effect-auth-compare/full-report.md` (the origin report;
  read the relevant section before opening a ticket, but verify every
  factual claim in it against current source — it is already wrong in
  places, see below). `spec/process/definitions-of-done.md` (provenance/
  release plan, M8). `spec/models/06-two-factor-totp.md` L103 (the one
  existing, non-normative mention of "encryption at rest" anywhere in
  `spec/`).
- Precedent: `Organization` and `Jwt` (`.scratch/organization/`,
  `.scratch/jwt/`) are this map's closest analogs — self-contained
  `.scratch/<feature>/spec.md` efforts needing no formal `spec/behaviors/`
  range. Unlike those, this map is **not one plugin** — it's six
  cross-cutting workstreams of very different weight (a README rewrite is
  not the same size as a persistent storage backend), so expect some
  tickets to close in one exchange and others to need their own research
  pass.
- Effect v4 primitives (SQL client, migrator, `LayerRef`, etc.) live in
  `../effect`'s own source — consult it directly rather than guessing at
  current API shape, same as `Jwt`'s ticket 05 did for `LayerRef`.
  Authorization primitives live in `../qadi`.
- Standing preference: ship the richer/more feature-complete option at
  every genuine fork, not the simpler one — recorded repeatedly across
  prior maps in this repo (memory `feedback-flexibility-over-complexity`).
  Doesn't license speculative unused infrastructure, though — this map
  exists partly *because* `RateLimitsRegistry` was already built and left
  unconsumed once.
- Hard rules carried into any resulting implementation tickets: no type
  assertions (`as`/`as unknown as`/`as any`) anywhere in library source,
  no exceptions without asking first; never annotate an Effect/Layer
  const's return type in new code.
- Skills every session should consult: `/grilling`, `/domain-modeling`.

## Decisions so far

- Destination and initial scope (this map's own charting round, resolved
  directly — no ticket): re-grounded the source report against current
  `main` before trusting any of its "gap" claims, since the report and
  the repo are both dated 2026-09-13 but the repo has moved fast since the
  report's `3ddefeb3f` snapshot (single squashed commit at report time;
  five real commits since, including full implementations of
  `Organization`, `Admin`, `Passkey`, and `Jwt` — four of the report's
  eight "empty stub" packages are no longer stubs). Concretely: (a) CI
  **already** runs the real test suite — `pnpm check` includes `coverage`
  (`vitest run --coverage`, all package tests) and `test:bdd`; the
  report's "CI runs zero tests" claim is simply false against current
  `check.yml`, so that item is dropped from this map entirely, no ticket;
  knip/dependabot parity folds into the governance ticket instead, as a
  minor addendum rather than its own workstream. (b) The HTTP wire
  surface is **much** larger than the report's "6 endpoints" — `Session`
  (5), `Subject` (1), and `Password` (4: sign-up, sign-in, request-reset,
  confirm-reset) are all wired today, plus whatever `Organization`/
  `Admin`/`Passkey`/`Jwt` added since (unaudited — folded into ticket 01).
  The real remaining wire gap is narrower: no endpoint consumes the
  existing email-verification token flow, and change-password/update-user/
  delete-user status is unconfirmed. (c) Item 6 from the report's "Top
  Next Moves" list (fill or delete the 8 stub packages) is dropped per
  this session's user, both because it's future work and because most of
  it is now moot per (a) above. (d) Every report recommendation tagged
  UPSTREAM (raise upstream's scrypt cost, split upstream's god-files,
  etc.) is dropped — `EduSantosBrito/effect-auth` is a different,
  unrelated library this repo has no relationship to; nothing in this map
  touches it.
- [00 — Effect v4 SQL/migration primitives survey](issues/00-effect-sql-migration-primitives-survey.md) — Effect v4 already ships everything ticket 03 needs: a real Postgres driver (`@effect/sql-pg`'s `PgClient`, `packages/sql/pg/src/PgClient.ts`), a forward-only file/table-convention migrator (`effect/unstable/sql`'s `Migrator.make` plus the `pg_dump`-backed `PgMigrator` wrapper), and first-class transactions (`SqlClient.withTransaction`, `SqlClient.ts:57-59`) — no framework-level gap, only a wiring decision remains.
- [01 — Account-lifecycle HTTP wiring gaps](issues/01-account-lifecycle-http-gaps.md) — full account-lifecycle scope: verify-email, update-user/profile, and delete-user are pure wiring onto existing `Users`/`Verification` capabilities; change-password is new (no core capability exists yet). Top-level routes (`/verify-email`, `/change-password`, `/user`), not nested under `/password/*`. Audit confirmed Organization/Admin/Passkey/Jwt's ~42 new endpoints don't overlap this scope.
- [02 — RateLimits consumption policy](issues/02-ratelimits-consumption-policy.md) — every mutating endpoint gets a rule from day one (sign-in, sign-up, reset-request, reset-confirm, change-password, OAuth callback); dual-keyed per rule (identity+IP where both exist, IP-only pre-identity); `TestAuth.layer` provides `RateLimits.layer` by default now that real consumers exist.
- [03 — Persistent SQL backend & migrations](issues/03-persistent-sql-backend-and-migrations.md) — Postgres ships now via `@effect/sql-pg`, an explicit, flagged supersession of ADR-EA-016's prior "speculative" rejection (that decision was scoped narrowly to one primitive, not a blanket freeze); `packages/core/src/Migrations.ts`'s scaffold wires onto Effect's own real `Migrator`, no third-party tool; a new `SqlTransaction` port in `@effect-auth/ports` wraps `SqlClient.withTransaction`, first consumed by OAuth account-linking completion.
- [04 — OAuth provider-token encryption at rest](issues/04-oauth-token-encryption-at-rest.md) — AES-256-GCM with row-binding AAD; a KMS-integration-point key-provider seam from day one (env-key-backed default layer, not a flat static key), `kid`-tagged for rotation; a dedicated cross-cutting encryption service (not a `Model` transform) since PKCE verifier/nonce is in scope too, reaching into the `__Host-oauth-state` cookie/`FlowPayload` path as well as SQL persistence.
- [05 — BDD scenario execution scope](issues/05-bdd-execution-scope.md) — step-definitions for every currently-implemented plugin (Password, Session, OAuth, Organization, Admin, Passkey, Jwt), not a representative slice — the map's single largest workstream, likely needing a per-plugin ticket-set split at `/to-tickets` time. Scenarios gated on still-in-flight tickets or excluded stub packages are pruned-but-tracked, not force-implemented.
- [06 — Release & governance readiness](issues/06-release-governance-readiness.md) — MIT license; CONTRIBUTING/SECURITY.md structurally templated from upstream's five governance files with this repo's own content; scaffolding only in this map (LICENSE/CHANGELOG/CONTRIBUTING/SECURITY, a working changeset, an unrun provenance-publish workflow) — actually publishing `0.1.0` needs manual npm/GitHub OIDC setup outside any agent's reach, deferred to a future **task**-type ticket; knip + dependabot fold in as a minor addendum.
- [07 — README & quickstart scope](issues/07-readme-quickstart-scope.md) — quickstart demonstrates a real composition against ticket 03's Postgres backend (a soft sequencing dependency beyond the ticket's own `Blocked by: 01`); README code blocks only, no separate `examples/` app; single flat ~500-line document mirroring upstream's shape rather than linking out to `spec/`; stale banner replaced with an accurate status line.

## Not yet specified

*(none — the frontier is now empty; all 8 tickets above are resolved.)*

Residual follow-on work surfaced *during* resolution, deliberately pushed
past this map's own destination rather than absorbed into it:

- Actually publishing `0.1.0` to npm (ticket 06(d)) — a future
  **task**-type ticket blocked on one-time manual npm/GitHub OIDC
  trusted-publishing setup, which no agent can perform.
- Recording ticket 03(a)'s supersession of ADR-EA-016's "speculative
  Postgres" rejection as its own follow-up note against ADR-EA-004/016 —
  an implementation-time documentation task, not a design decision.
- Splitting ticket 05's BDD scope into one ticket-set per plugin — an
  implementation-planning detail for `/to-tickets`, not this map's own
  frontier.

## Out of scope

- **The 8-stub-package cleanup** (report's "Top Next Moves" item 6: ship
  or cut `two-factor`/`passkey`/`magic-link`/`admin`/`organization`/
  `api-key`/`next`/`cli`) — ruled out per this session's user as future
  work, independent of this map's destination. Four of the eight
  (`organization`, `admin`, `passkey`, and the not-originally-listed
  `jwt`) are no longer stubs as of this charting round anyway; the
  remainder (`api-key`, `two-factor`, `magic-link`, `next`, `cli`) stay
  untouched here.
- **Every report recommendation tagged UPSTREAM** (weak scrypt params,
  the three ~2,050-LOC god-files, the `oauth`↔`storage` import cycle, no
  CSRF layer, no RBAC — all in `EduSantosBrito/effect-auth`) — that repo
  is not this library; this session's user was explicit about that, and
  this map has no way to act on someone else's repository regardless.
- **`Organization` and `Jwt` BDD step-definitions** ([23 — Organization step-definitions](issues/23-bdd-organization.md), [26 — Jwt step-definitions](issues/26-bdd-jwt.md)) — ticket 05's own decision text said step-definitions were owed for "every currently-implemented plugin (Password, Session, OAuth, Organization, Admin, Passkey, Jwt)", but that listing conflicts with this map's own Notes above, which correctly names `Organization`/`Jwt` as the two plugins deliberately speced *outside* the formal `spec/behaviors/`+`features/` system from the start (`.scratch/organization/spec.md`, `.scratch/jwt/spec.md`) — neither has a `spec/behaviors/` entry or a `.feature` file to wire, so there was never a real gap to close for them under this workstream. Surfaced and corrected while executing tickets 23/26; `Admin` (`27-admin-impersonation.md`) does have real `spec/behaviors/` coverage and is not affected by this correction.
