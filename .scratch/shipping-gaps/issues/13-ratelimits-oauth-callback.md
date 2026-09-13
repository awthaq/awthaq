# 13 — OAuth callback rate limit

**What to build:** The OAuth callback endpoint is throttled by IP.

**Blocked by:** 12

**Status:** done

## Result

`OAuthApi.callback` now declares `Api.RateLimited`. `OAuth.ts`'s
`callback` capability enforces it directly (mirroring ticket 12's
`RateLimiter.consume` pattern) and registers into the introspectable
registry (mirroring ticket 12's `RateLimitsRegistry.register` inline
pattern, including the same narrow, justified return-type annotation to
break the same TS circularity ticket 12 first hit). 20 attempts per
minute, keyed by source IP.

**Correction to ticket 12's own framing, discovered here:** ticket 12
said this codebase "has no client-IP-extraction mechanism anywhere" and
deferred IP-based keying entirely on that basis. That was too
pessimistic — `packages/oauth/src/OAuth.ts`'s own `callback` handler
*already* destructures `request: HttpServerRequest.HttpServerRequest`
from its handler params (an existing pattern, not new), and
`HttpServerRequest.remoteAddress: Option.Option<string>` is a first-class
framework primitive. Wiring it through needed nothing new — `OAuthShape.callback`
gained an optional `ip` field, the handler passes
`Option.isSome(request.remoteAddress) ? {ip: ...} : {}` (an
`exactOptionalPropertyTypes`-safe conditional spread), and the capability
keys on `` `oauth:callback:${input.ip ?? "unknown"}` ``, sharing one
bucket for the no-IP case rather than leaving it unthrottled. This
doesn't retroactively change ticket 12's own shipped Password endpoints
(already done and tested) — noted here for whoever might revisit them,
not acted on unprompted.

New wire-level test (`AuthHttp.test.ts`): a dedicated
`ThrottledAppLayer` (real `RateLimiter.layer`/`layerStoreMemory`, not the
permissive default every other test in the file uses) proves 20 garbage
callbacks succeed as ordinary 400s and the 21st answers 429. `pnpm
--filter @effect-auth/oauth test` — 29 tests, green. `pnpm test` — 570
tests, all green; `pnpm typecheck`/`pnpm lint`/`pnpm format:check` clean
workspace-wide.

- [ ] OAuth callback keys on IP alone — no identity exists yet at that
      point in the flow
- [ ] Exceeding the threshold yields a throttled response, asserted in
      the OAuth plugin's existing wire-level test file
- [ ] Uses the exact same `RateLimits` mechanism/pattern established in
      ticket 12 — no parallel implementation
