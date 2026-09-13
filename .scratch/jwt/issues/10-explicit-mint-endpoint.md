# 10 — Explicit mint endpoint

**What to build:** an already-authenticated caller can request a fresh
JWT representing themselves over HTTP.

**Blocked by:** 08 — Sign and stateless verify

**Status:** done

- [ ] `GET /auth/jwt/token`-shaped endpoint, gated by the existing
      `Authentication` middleware (cookie or bearer — whichever the
      caller already used), no request payload accepted (claims are never
      client-suppliable at the wire level)
- [ ] Returns the signed token from `sign(currentPrincipal)`
- [ ] An unauthenticated request is rejected the same way any other
      `Authentication`-gated endpoint rejects one
- [ ] Wire-level test: authenticate, call the mint endpoint, verify the
      returned token against `Jwt`'s own `jwks`/`verify`, confirm claims
      match the caller


## Result

Done. `JwtApi.ts` gained a second group, `jwt.token` (`GET /jwt/token`,
`.middleware(Api.Authentication)`), following this codebase's own
established pattern for a plugin mixing public and authenticated endpoints
— a second, dotted-sub-id group carrying its own middleware (mirroring
`PasskeyApi.ts`'s `passkey`/`passkey.authenticate` split), never a
per-endpoint middleware call inside one shared group. `Jwt.ts`'s
`JwtHandlers` is now `Layer.mergeAll` of two `HttpApiBuilder.group` calls
(one per group) rather than one — mirroring `PasskeyHandlers`'s own shape.
The handler resolves `Api.CurrentPrincipal` (provided by the `Authentication`
middleware) and calls the already-existing `jwt.sign`, wrapping its
(effectively unreachable in practice, since the endpoint never sees an
unauthenticated caller — see below) `JwtInvalidError` in `Effect.orDie`,
since a signing failure is a WebCrypto/infra fault, not something a caller
could act on, and the endpoint's own declared error surface stays just
`Unauthenticated` rather than needing a second typed error.

**Fallout fixed**: `Jwt.layer` now bundles a real authenticated group, so
its own required context grew to include `Api.Authentication` — this broke
both of ticket 08/09's already-passing test files, which built `Jwt.layer`
without it. Fixed by adding the same `AuthenticationLive` (
`Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive))`)
+ `Sessions.layerMemory` composition `packages/organization`'s own test
files already establish as this codebase's standard fix for the identical
situation.

Added to `AuthHttp.test.ts`: a 401 test for an unauthenticated request, and
a full mint→verify test. The verify step deliberately does **not** resolve
`Jwt.Jwt` from a second, independently-built layer (that would mint against
a *different* `KeyRing`'s keys, unable to verify a token the real `handler`
signed) — it fetches real JWKS over the same `handler` and verifies with
`JwtCodec.verify` directly, the exact module `Jwt.verify` itself wraps.

**Verification**: `pnpm --filter @effect-auth/jwt typecheck` clean,
`pnpm exec tsc -p tsconfig.test.json` clean, `pnpm --filter @effect-auth/jwt test` —
4 files, 22 tests total (this ticket's own 2 new), all passing. `pnpm lint`/
`pnpm format:check` clean workspace-wide.
