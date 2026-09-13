# 14 — General-purpose signJWT/verifyJWT

**What to build:** an application's own in-process code can sign and
verify a JWT over any payload it chooses, not just a session-derived
principal, reusing this plugin's key/rotation machinery.

**Blocked by:** 08 — Sign and stateless verify

**Status:** done

- [ ] `signJWT(payload, options?)` — arbitrary caller-supplied payload,
      reusing the same claims-assembly and key/rotation machinery as
      `sign`; an explicit per-call payload value takes precedence over
      `definePayload`'s computed default, per the documented precedence
      rule; `nbf`/`jti` carried through only if explicitly supplied
- [ ] `verifyJWT(token)` — the same verification checks as `verify`,
      without assuming any particular claim shape beyond the registered
      ones
- [ ] Both are plain Effect service methods only — no HTTP endpoint, since
      no real caller needing a wire hop has been identified
- [ ] Test: sign an arbitrary payload unrelated to any session, verify it
      round-trips correctly; confirm an explicit payload value overrides
      `definePayload`'s default for the same key


## Result

Done. `sign` was refactored to extract a shared `signClaims(claims, ttl?)`
helper (still inside `make`'s own closure) that both `sign` and the new
`signJWT` reduce to — the one place `iat`/`exp`/`iss`/`aud` are computed
and always win over whatever `claims` the caller already assembled. This is
the "reusing the same claims-assembly and key/rotation machinery as
`sign`" the ticket asked for, made concrete as an actual shared function
rather than two independent implementations that happen to agree.

**Deliberate deviation from the ticket's literal wording, documented
in-code**: the ticket says an explicit `signJWT` payload value should take
precedence over `definePayload`'s computed default. `JwtConfig.definePayload`'s
real signature is `(principal: Api.Principal) => Effect.Effect<...>` —
principal-scoped — and `signJWT` has no principal at all, so there is
nothing to call it with. `signJWT` does not consult `definePayload`; what
does still hold, unchanged from `sign`'s own contract, is that registered
claims always win over the caller's payload. Flagged here rather than
forcing an awkward signature change to `definePayload` outside this
ticket's own scope.

`verifyJWT` is `verify` itself, not a second implementation — `verify`
never assumed any particular principal shape beyond a present, non-empty
`sub`, so the checks are already identical.

`signJWT`'s `options?: { readonly ttl?: Duration.Duration }` allows a
per-call TTL override, threaded through to the shared `signClaims` helper.

Tests: arbitrary-payload sign→verify round trip unrelated to any session;
registered claims (`iss`) winning over an attacker-shaped payload key of
the same name; a per-call `ttl` override actually taking effect
(`TestClock`-driven expiry).

**Verification**: `pnpm --filter @effect-auth/jwt typecheck` clean,
`pnpm exec tsc -p tsconfig.test.json` clean, `pnpm --filter @effect-auth/jwt test` —
22 tests total, all passing. `pnpm lint`/`pnpm format:check` clean
workspace-wide (checked once, covering all three of this phase's tickets).
