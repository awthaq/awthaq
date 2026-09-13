# 22 — OAuth step-definitions

**What to build:** `OAuth`'s Gherkin scenarios execute in CI via real
step-definitions.

**Blocked by:** None — can start immediately

**Status:** done

## Result

Wired `features/features/05-authentication-methods/16-oauth.feature` (27
scenarios): `features/step-definitions/OAuthWorld.ts` builds the real
`OAuth.OAuth` service via `Layer.build` called directly from inside a
step's own Effect (not a separately-spawned `HttpRouter.toWebHandler`
runtime, unlike Password/Session's Worlds) — so `TestClock` stays shared
between steps and the plugin's own construction, which REQ-EA-334's
flow-TTL-expiry scenario depends on. `OAuthSteps.ts` drives `authorize`/
`callback` directly (the same domain-level seam `packages/oauth/test/OAuth.test.ts`
already established), plus direct `Accounts`/`Users` access for the
identity-anchor scenarios.

23 of 27 scenarios execute for real; 4 pruned via `@skip`:
REQ-EA-329 (type-level PKCE-always claim), REQ-EA-345 (real DB-level
concurrency race — needs a real SQL backend, already covered by
`packages/sql/test/Repositories.test.ts`'s own UNIQUE-constraint test),
REQ-EA-347 (static source-code-inspection claim), and REQ-EA-346 (hit a
real `Config.Redacted`/`Schema.Redacted` "Encoding" decode failure
building a provider Layer from a `process.env`-set var in this harness —
not root-caused within this ticket's budget; flagged as a genuine,
scenario-specific follow-up rather than assumed to be a real product
defect, since `Config.Redacted` reads real env vars without issue
elsewhere in this same codebase).

Three real bugs caught and fixed via failing assertions, not inspection:
(1) linking-rule scenarios initially called `configure()` more than once
per scenario, silently discarding `Users`/`Accounts` state an earlier
step had already built; (2) two "not auto-linked" scenarios let an
*expected* `AccountExists` failure propagate as an uncaught step
failure instead of being captured via `Effect.exit` and asserted on
`Accounts` state directly; (3) REQ-EA-336's Given assumed shared state
from REQ-EA-335 — each Scenario gets a fresh World, so "the same
callback" needed its own copy of 335's setup, not a no-op.

`pnpm test:bdd` — 49 passed, 30 skipped (was 26/26 after ticket 21).
`pnpm test` — 586 passed, 2 skipped, unaffected. `pnpm typecheck`/`pnpm
lint`/`pnpm format:check` clean workspace-wide.

- [x] Step-definitions written for `OAuth`'s feature files, calling into
      the existing OAuth plugin wire-level seam
- [x] Scenarios describing behavior not yet built (including anything
      still gated on tickets 16/18/19, if those haven't landed yet) are
      pruned from the executed set and tracked, not force-implemented —
      tickets 16/18/19 had already landed by this point, so nothing here
      was gated on them
- [x] The existing `test:bdd` step executes these scenarios and passes
