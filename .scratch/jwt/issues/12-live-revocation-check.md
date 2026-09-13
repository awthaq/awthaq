# 12 — Live revocation check (verifyLive)

**What to build:** an application that needs revocation-aware
verification — not just signature/claims validity — has a way to get it,
for callers that do have access to the live session store.

**Blocked by:** 08 — Sign and stateless verify

**Status:** done

- [ ] `verifyLive(token)` — a separate, distinctly-named export from
      `verify` (not a flag), requiring `Sessions` in its own service
      requirements — performs every check `verify` does, then additionally
      confirms the token's `sid` claim still names a live, unrevoked
      session
- [ ] Test: mint a token, confirm both `verify` and `verifyLive` succeed;
      revoke the underlying session; confirm `verify` still succeeds (the
      documented, deliberate weakening) while `verifyLive` now fails


## Result

Done. `verifyLive` added to `JwtShape`/`Jwt` as the one deliberate
exception to this file's own "capture everything in `make`, keep every
method's `R` at `never`" convention — it requires `Sessions` directly, not
captured in `make`, since `Sessions` must not become a hard dependency of
installing `Jwt` at all (`dependsOn: []`; ordinary sign/verify/jwks work
standalone). It is never wired to an HTTP handler, so the
`HttpApiBuilder.group` discharge constraint that motivates the `R = never`
convention for every other method doesn't apply to it; a caller invoking
it provides `Sessions` at their own call site — trivial in practice, since
any app hosting `Jwt` already has `Sessions` in its `Auth.make` composition.

**Design decision found during implementation, not in the ticket's own
wording**: `Sessions.SessionsShape` has no bare "look up by session id
alone" operation — only `verify` (needs the full `id.secret` credential a
JWT never carries, by design: embedding the session secret in a JWT would
let a JWT holder also use it as a raw session token elsewhere) and `revoke`
(destructive). Implemented the live check via `Sessions.list(userId, ...)`
— using the token's own `sub`/`sid` claims — checking for a still-present,
still-unexpired row with that id. This uses only capabilities `Sessions`
already exposes, keeping this ticket's own no-core-touch scope intact
(the core touch belongs to ticket 16 alone, as the map's own destination
decision requires).

Both `verify` and `verifyLive` collapse every failure to the same
`JwtCodec.JwtInvalidError` tag — including "session no longer live" — for
consistency with the plugin's existing "don't leak which check failed"
posture; there is no new, separately-named error for this case.

Tests: a full mint → verifyLive-succeeds → revoke → verify-still-succeeds
(the documented weakening) → verifyLive-now-fails sequence; plus a token
with no `sid` at all (minted via `signJWT`, ticket 14) correctly fails
`verifyLive` rather than throwing or vacuously succeeding.

**Verification**: `pnpm --filter @effect-auth/jwt typecheck` clean,
`pnpm exec tsc -p tsconfig.test.json` clean, `pnpm --filter @effect-auth/jwt test` —
22 tests total, all passing.
