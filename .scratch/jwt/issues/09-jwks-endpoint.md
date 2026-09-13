# 09 — JWKS endpoint

**What to build:** anyone — including a caller outside this application
entirely — can fetch the current set of public verification keys over
HTTP.

**Blocked by:** 07 — Key generation, persistence, and the KeyRing

**Status:** done

- [ ] `GET /auth/jwt/jwks` contract endpoint, unauthenticated (JWKS is
      public by definition)
- [ ] Returns every key not yet past its `retiresAt` — including a key
      past `rotatedAt` but still within its grace period
- [ ] Never serializes private key material, under any configuration
- [ ] Wire-level test (`AuthHttp.test.ts`): fetch JWKS with only `Jwt`
      installed, confirm the shape and confirm no private fields leak

## Result

Done. `JwtApi.ts` (new) carries the plugin's first real HTTP group —
`GET /jwt/jwks` (path corrected from the ticket's own loose
`/auth/jwt/jwks` phrasing to match this codebase's real, established
per-plugin path convention — see the file's own header comment).
`JwtHandlers` (in `Jwt.ts`) wires it to `jwt.jwks`, wrapping the plain
`{keys: [...]}` value in a real `JwksResponse` instance (a bare object
didn't satisfy the `Schema.Class` response encoder — caught by the wire
test itself). Never serializes `privateKeyJwk`, under any configuration —
the response only ever carries each key's `publicKeyJwk`.

As Phase A's own discovery predicted, this ticket's real group means
`Auth.make([Jwt.Jwt])` now composes *alone* — `AuthComposition.test.ts`'s
"Jwt-only tuple fails" test (accurate only while the contract was empty)
was replaced with a "composes alone" test proving the opposite is now
true, plus the original "composes alongside another plugin" test kept
unchanged.

**Verification**: wire-level `AuthHttp.test.ts` (new) fetches JWKS over a
real `HttpRouter.toWebHandler`, confirms a well-formed key and no private
fields. `pnpm --filter @effect-auth/jwt typecheck`/`tsc -p tsconfig.test.json`
clean, `pnpm --filter @effect-auth/jwt test` — 4 files, 15 tests, all
passing. `pnpm lint`/`pnpm format:check` clean workspace-wide.
