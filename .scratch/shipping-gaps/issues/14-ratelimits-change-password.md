# 14 — Change-password rate limit

**What to build:** The change-password endpoint (ticket 11) is throttled
by identity.

**Blocked by:** 11, 12

**Status:** done

## Result

Same pattern as ticket 12: `RATE_LIMITS.changePassword` (5/15min),
`Api.RateLimited` declared on the endpoint, `rateLimit(...)` called first
inside the capability, a registry registration entry added. Keyed on
`userId` directly (the endpoint is authenticated, so — unlike `signIn`/
`requestReset` — there's no need to look up an email first). No new
ripples: the `RateLimiter`/`RateLimitsRegistry` requirements were already
satisfied everywhere by ticket 12's own changes.

New throttle test in `Password.test.ts`, same shape as ticket 12's
`signIn` one, reusing the same dedicated real-limiter layer composition:
5 wrong-current-password attempts succeed as ordinary `WrongPassword`,
the 6th answers `RateLimited`. `pnpm test` — 571 tests, all green;
`pnpm typecheck`/`pnpm lint`/`pnpm format:check` clean workspace-wide.

- [ ] Change-password keys on identity/email, matching the pattern
      established in ticket 12
- [ ] Exceeding the threshold yields a throttled response, asserted in
      ticket 11's own wire-level test file
