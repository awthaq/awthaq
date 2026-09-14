# Upstream hardening — session security, data-layer, and CI supply-chain

## Destination

A set of resolved decision tickets covering the genuinely-still-open gaps
surfaced by a second upstream-comparison pass (the same "50-slice evidence
base" `.scratch/shipping-gaps` drew from), re-grounded against this repo's
*current* source rather than trusted at face value — the pasted report was
already wrong or stale about several claims by the time this map was
charted (see the charting decision below). Ready to hand to `/to-tickets`
once resolved.

In scope, narrowed to what's confirmed still missing after re-grounding:

1. Session token rotation on refresh (session-fixation defense).
2. A `revoke-all` session operation, alongside the existing `revokeOthers`.
3. DB indexes (`sessions.user_id`, `accounts.user_id`) and a real unique
   constraint on `users.email`.
4. An email-verification gate on sign-in, plus a resend-verification
   endpoint.
5. GitHub Actions SHA-pinning + a least-privilege `permissions:` block on
   `check.yml`.
6. A zizmor workflow-security scanning workflow (SARIF).
7. Effect-specific lint-rule coverage under this repo's actual toolchain
   (`oxlint`, not ESLint — the pasted "effect-rules preset" claim assumed
   the wrong linter) and confirming/completing `@effect/language-service`
   diagnostic severity.
8. An npm publish smoke path (`package:smoke` dry-run, optionally
   pkg-pr-new previews) — orthogonal to actually publishing, which stays
   blocked on manual OIDC setup per `shipping-gaps` ticket 06.
9. A runnable example workspace + a publicly-exported memory dev layer
   (today `packages/test/src/TestAuth.ts`'s memory layer is real but not
   packaged as a standalone example).

**Explicitly out of scope**: see Out of scope below — both the pasted
report's own "deliberately not worth importing" list, and claims this
map's own grounding pass found stale or false.

## Notes

- Domain: this map originates from a user-pasted ranked comparison
  (Tier 1/2/3 gaps against `EduSantosBrito/effect-auth`), re-verified
  against current source before charting — see the grounding pass below.
  `.scratch/shipping-gaps/map.md` is the closest precedent: same evidence
  base, prior round, now fully resolved. Read its tickets 01 (account-
  lifecycle HTTP wiring), 04 (OAuth token encryption — confirms the
  pattern of a dedicated cross-cutting service, not a model-field
  transform), and 06 (release/governance — owns the *actual* publish gate
  as future manual work) before opening the overlapping tickets here.
- Effect v4 primitives live in `../effect`'s own source — consult it
  directly. Authorization primitives live in `../qadi`.
- Standing preference: ship the richer/more feature-complete option at
  every genuine fork, not the simpler one (memory `feedback-flexibility-
  over-complexity`).
- Hard rules carried into any resulting implementation tickets: no type
  assertions (`as`/`as unknown as`/`as any`) anywhere in library source,
  no exceptions without asking first; never annotate an Effect/Layer
  const's return type in new code.
- Skills every session should consult: `/grilling`, `/domain-modeling`.

## Decisions so far

- Destination and initial scope (this map's own charting round, resolved
  directly — no ticket): ran a full grounding pass against current source
  before trusting any of the pasted report's claims, per the same
  discipline `shipping-gaps` used. Confirmed genuinely open: session
  rotation (`packages/core/src/Sessions.ts:227-286` idle-refreshes but
  never rotates the secret), `revoke-all` (only `revoke`/`revokeOthers`
  exist, `Sessions.ts:159-160,308-311,469-470`), DB indexes/unique-email
  (`packages/sql/src/CoreMigrations.ts:58-143` — zero indexes on
  `accounts.userId`/`sessions.userId`, no unique constraint on `email`),
  the sign-in verification gate (`Password.ts:468-509`'s `signIn` never
  reads `emailVerified`; no resend endpoint), SHA-pinning (`check.yml`
  uses tag refs, no `permissions:` block, unlike `release.yml`), and
  zizmor (no workflow-security scanning exists at all). Confirmed
  **already fully shipped**, dropped from this map: OAuth provider-token
  encryption at rest — `packages/ports/src/Encryption.ts`'s AES-256-GCM/
  WebCrypto envelope is real, consumed by both `packages/oauth/src/
  OAuth.ts` and `packages/sql/src/Repositories.ts`, not merely a
  `shipping-gaps` ticket-04 design decision. Confirmed **stale/false**,
  dropped: "CI never builds on PR" (`check.yml`'s `pnpm check` already
  builds per `package:json`'s script composition); "88 `any`s, 15 in
  `AuthPlugin.ts`" (actual count today: 2 `any`s total, in `Jwt.ts` and
  `Api.ts`; `satisfies` count is 7 against upstream's 41, not 8 — close
  enough not to re-litigate as its own ticket). Confirmed **partially
  overstated**: the "effect-rules preset, only 1 lint rule" claim assumed
  ESLint, but this repo lints with `oxlint` (`.oxlintrc.json` does have
  exactly 1 rule, confirming that half); `tsconfig.base.json:68-77`
  already fails tsc on Effect *errors* (`ignoreEffectErrorsInTscExitCode:
  false`), so "LS diagnostics don't fail tsc" is only true for warning-
  level diagnostics, not the whole claim — folded into ticket 07 as a
  narrower question. The npm-publish-smoke gap is confirmed but is
  **known tracked debt**, not new: `release.yml`'s own header comment
  already documents the wired-but-inert state pending a package going
  public; ticketed anyway since `package:smoke` (a dry-run) needs no
  publishing credentials and is agent-doable now, unlike the actual
  publish. The example-workspace/memory-dev-layer gap is real but
  partial — `TestAuth.ts`'s memory layer is production-quality, just not
  exported as a standalone example — ticketed per this session's user
  (deferring it to fog was the alternative, declined).
- **Ticket 07 (effect lint coverage under oxlint) — resolved by research,
  then superseded by direct implementation**, see
  `.scratch/upstream-hardening/issues/07-effect-lint-coverage-under-oxlint.md`'s
  `## Answer` and `## Superseded by direct implementation` sections for full
  detail. The research correctly found oxlint has no *published* Effect-rule
  plugin, but missed that `../effect` ships its own private `@effect/oxc`
  oxlint JS-plugin (5 real rules, loaded as raw TypeScript via Node's native
  type-stripping, no build step) that the Effect team runs on their own
  monorepo today. Per this session's user (explicit "never ESLint, keep
  oxlint" instruction), ported that directly instead of the researched
  ESLint-dual-linter path: all 5 rules copied verbatim into `tools/oxc/`,
  4 wired live in `.oxlintrc.json` (`no-bigint-literals`,
  `no-import-from-barrel-package` — scoped to `effect`/`@effect/*` only,
  deliberately not this repo's own `@awthaq/*` namespace-barrel convention —
  `no-js-extension-imports`, `no-opaque-instance-fields`). Enabling them
  surfaced ~374 real pre-existing barrel-import violations across 124 files;
  all fixed (mechanical import rewrites, no logic changes), full `pnpm
  check` green afterward. `no-unused-internal` (the 5th rule) is ported but
  disabled — it depends on TypeScript's classic compiler API, which doesn't
  exist under the TS7/tsgo rewrite this repo pins; see the ticket's
  Superseded section and this map's Not yet specified below. Separately, and
  sharper than this map's own grounding pass first framed it:
  `tsconfig.base.json:74` sets `ignoreEffectWarningsInTscExitCode: true`,
  an **opt-out** of `@effect/language-service`'s own default (`false` —
  warnings fail tsc by default upstream). All 16 currently-warning-level
  diagnostics (including `outdatedApi`, relevant to this repo's Effect v4
  target) are emitted but don't fail `tsc` here, and are named candidates
  for promotion to `error` via `diagnosticSeverity` in a future ticket.

- [01 — Session token rotation on refresh](issues/01-session-token-rotation.md) — piggybacks on the existing `touchEvery` throttle (one write path, no new timer); delivery splits by auth scheme per the user's "richest, complexity not a concern" steer — `Set-Cookie` for the `cookie` scheme (the only mechanism a browser actually acts on), a `set-auth-token` header for `bearer` (upstream's own mechanism, needed since a header alone can't rotate a browser's cookie jar); `AuthenticationLive`'s shared `cookie`/`bearer` handler splits into two closures to make this possible; `verify`'s return shape changes to carry an optional rotated token, a real public-API break whose call-site audit is deferred to `/to-tickets`; old secret invalidates immediately, no grace window (matches every other write in this codebase — no dual-valid-state precedent to extend).
- [02 — `revoke-all` session operation](issues/02-revoke-all-sessions.md) — completes the `revoke`/`revokeOthers`/`revokeAll` naming symmetry, no exceptions (kills the caller's own session too); `POST /session/revoke-all` on the existing `session` group, no payload, no response cookie-clearing (matches `signOut`'s existing precedent); confirmed `confirmReset` already fakes this today via `revokeOthers(userId, SessionId(""))` — a real gap, not equivalent — and should swap to the real primitive once it exists.
- [03 — DB indexes and a real unique constraint on `users.email`](issues/03-db-indexes-unique-email.md) — turned out to be a bug fix, not a design question: `Users.ts`'s own header comment and `layerSql.create`'s already-written `UniqueViolation`→`EmailAlreadyExists` handling both already assume the DB constraint exists; the migration just never created it, so a real DB today silently accepts duplicate emails. Three new migrations (7/8/9, not folded into 1-3 — matches this file's own migration-5 precedent of indexes as separate migrations): a `UNIQUE` index on `lower(email)`, plain indexes on `accounts."userId"`/`sessions."userId"` (both confirmed real filter keys in `Repositories.ts`). No index needed on `sessions.secretHash` — `verify` always looks up by primary-key `id`, never by secret.

## Not yet specified

- Enabling `effect/no-unused-internal` (the 5th ported oxlint rule) once
  either effect's own rule is rewritten against TypeScript 7/tsgo's new
  modular compiler API (the classic `ts.createSourceFile`/`ts.SyntaxKind`
  surface it depends on no longer exists at `typescript`'s top-level
  import), or this repo pins back to TS6. Not sharp enough to ticket yet —
  depends on upstream `../effect` action this repo doesn't control.
- `@effect/language-service`'s 16 currently-warning-level diagnostics
  (ticket 07's Answer names them all, `outdatedApi` most relevant given
  this repo's Effect v4 target) as promotion-to-`error` candidates via
  `diagnosticSeverity` — real, but which ones and how aggressively isn't
  pinned down yet.

## Out of scope

- **Every item on the pasted report's own "deliberately not worth
  importing" list** (Bun migration/single-package collapse, upstream's
  flat 293-symbol API surface, configurable cookie names/`SameSite=Lax`
  default/derived `Secure`, upstream's hand-rolled `{status,body}` error
  switch) — the report itself already argued these are net losses against
  this repo's current design; nothing here disputes that, so none became
  tickets.
- **"CI never builds on PR"** — stale against current `check.yml`, which
  already runs `pnpm check` (build+coverage+bdd) on every PR. No ticket;
  corrected during this map's own grounding pass.
- **"88 `any`s (15 in `AuthPlugin.ts`), 41 vs 8 `satisfies`"** — false
  against current source (actual: 2 `any`s, 7 `satisfies`). No ticket;
  corrected during this map's own grounding pass.
- **Actually publishing to npm** — stays owned by `shipping-gaps` ticket
  06's residual note: blocked on one-time manual npm/GitHub OIDC
  trusted-publishing setup no agent can perform. This map's own ticket 08
  covers only the dry-run smoke path, not the real publish.
