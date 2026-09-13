# 08 — Sign and stateless verify

**What to build:** an authenticated caller's `Principal` can be turned
into a signed JWT, and that JWT can be verified back — the core round trip
every other capability in this plugin builds on.

**Blocked by:** 07 — Key generation, persistence, and the KeyRing

**Status:** done

- [ ] `sign(principal)` assembles registered claims from the principal and
      config: `sub` (user id), `sid` (session id, always), `act`
      (populated, RFC 8693-style, exactly when the principal carries
      `actingAs`; omitted entirely otherwise), `iat`/`exp` (via the
      ambient `Clock`), `iss`/`aud` (from `JwtConfig`) — plus whatever
      `definePayload` computed, under the documented precedence (explicit
      value wins, else the config default, else absent)
- [ ] `verify(token)` checks: well-formed token with a `kid`; signing
      algorithm against the configured allowlist (never trusting the
      token's own declared `alg` without cross-checking); signature
      against the matching `KeyRing` key; `iss`/`aud` against configured
      values; `exp` against the ambient `Clock`; `sub` present — every
      distinct failure collapsing to one undifferentiated invalid-token
      error
- [ ] The claims-assembly and verification-check logic live in one shared
      internal module — not duplicated — since ticket 13 (lite verifier)
      and ticket 09 (JWKS) both need to reuse pieces of it
- [ ] Test: sign a principal (with and without `actingAs`), verify the
      result succeeds and every claim is correct; tamper with the
      signature and confirm verification fails; advance `TestClock` past
      `ttl` and confirm verification fails

## Result

Done. `JwtCodec.ts` (new) is the shared, `AuthPlugin`-independent module:
compact-JWS assembly/parsing (via `Schema.fromJsonString` decoding rather
than raw `JSON.parse` + assertions — this repo's standing no-assertions
rule applied even to untrusted wire data), EdDSA/ES256 sign+verify via
WebCrypto, and one undifferentiated `JwtInvalidError` for every distinct
verification failure. `Jwt.ts`'s `make` now resolves `JwtConfig` and the
`KeyRing` *reference itself* (not its resolved value) once at the top,
letting `sign`/`verify` read fresh key state on every call — via
`ref.get`, a plain concrete `Layer` with no further ambient requirement —
while keeping every `JwtShape` method's own `R` at `never`, matching this
codebase's established plugin-shape convention (the same "capture once in
`make`" lesson `Organization`'s ticket 19 already documented, applied here
to a `LayerRef` rather than an ordinary `Context.Service`).

`sub`/`sid`/`act` populate from the `Principal` exactly as ticket 08
specified; `sid`/`act` exist only for a `UserPrincipal` (the only kind
`Authentication`'s own `resolvePrincipal` ever actually produces). Extra
claims from `JwtConfig.definePayload` are merged *underneath* the
registered claims (spread first, registered claims spread after) so a
config-supplied payload function can never override `sub`/`iss`/etc. —
confirmed by a regression test.

**Verification**: `pnpm --filter @effect-auth/jwt typecheck` clean,
`pnpm exec tsc -p tsconfig.test.json` clean, `pnpm --filter @effect-auth/jwt test`
— 4 files, 15 tests, all passing. `pnpm lint`/`pnpm format:check` clean
workspace-wide.
