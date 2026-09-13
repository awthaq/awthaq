# 13 — Lite verifier subpath export

**What to build:** a service that never installs `effect-auth` at all can
still verify a JWT this plugin issued, using only its own dependency on
one narrow, independent module.

**Blocked by:** 08 — Sign and stateless verify; 09 — JWKS endpoint

**Status:** done

- [x] A subpath export of `@effect-auth/jwt` (e.g. `@effect-auth/jwt/verify`)
      whose import graph contains no `AuthPlugin`, no `Sessions`, no other
      core service — only `effect` itself and an HTTP client for JWKS
      retrieval
- [x] Reuses the shared claims/algorithm-verification module from ticket
      08 and a JWKS-fetch-with-caching-and-refresh-on-unknown-`kid`
      routine, rather than duplicating either
- [x] Has no access to `verifyLive` — a documented limitation, not a bug —
      since it never has `Sessions` available
- [x] A dedicated test file, deliberately not routed through
      `TestAuth`/plugin composition at all: feed it a really-signed token
      and a real JWKS document (produced by a setup step using the full
      plugin), and exercise valid-token acceptance, tampered-signature
      rejection, wrong `iss`/`aud` rejection, expired-token rejection (via
      `TestClock`), unknown-`kid` rejection, and malformed-token rejection

## Result

Done. `packages/jwt/src/verify.ts` (previously a placeholder reserved in
ticket 06) is now the real lite-verifier module: `makeVerifier(options)`
builds a `Verifier` (one `{verify: (token) => Effect<...>}`) bound to a
JWKS URL/issuer/audience/algorithm, with its own `Ref`-backed key cache —
built once (e.g. at a downstream service's own startup), reused across
calls. Fetches JWKS lazily on first `.verify()` call, and exactly once
more on a token naming an unknown `kid` (the standard "unknown kid →
refetch" pattern), via `Effect.catchIf` keyed on `JwtCodec.JwtInvalidError`'s
own internal `reason` field — no infinite-refetch risk, since the retry's
own failure is never itself wrapped in another catch.

Reuses `JwtCodec.ts` entirely (already independent of `AuthPlugin`/
`Sessions`/core, per ticket 08) for both signing-envelope parsing and the
actual claims/signature checks — no duplicated verification logic. JWKS
documents are decoded via `HttpIncomingMessage.schemaBodyJson` (a real
`Schema`, not a raw `JSON.parse` + assertion); each fetched JWK's `kid`/`alg`
are read off the decoded `Record<string, unknown>` via a plain
`typeof`/equality narrow (`typeof kid === "string" && (alg === "EdDSA" || alg === "ES256")`),
never a type assertion — deliberately stricter than
`packages/oauth/src/OAuth.ts`'s own older `response.json() as {...}`
precedent, which predates this codebase's now-established Schema-based
idiom for untrusted wire data.

**Import-graph check, confirmed by hand**: `verify.ts`'s only imports are
`effect/Effect`, `effect/Option`, `effect/Ref`, `effect/Schema`,
`effect/unstable/http/HttpClient`, `effect/unstable/http/HttpIncomingMessage`,
and `./JwtCodec.ts` — a `grep -E "@effect-auth/(core|server)|\./Jwt\.ts|\./KeyRing\.ts"`
over just the file's `^import` lines prints nothing. `package.json`'s
existing `"./*"` export wildcard (reserved in ticket 06) already resolves
`@effect-auth/jwt/verify` correctly for both the `bun`/dev path
(`./src/verify.ts`) and the built path (`./lib/verify.js`) — no
`package.json` change was needed.

No `verifyLive`-equivalent exists here and none was added — confirmed as
a documented limitation, not a gap, consistent with ticket 03/05's own
resolved decision.

Added `packages/jwt/test/verify.test.ts` (6 tests), deliberately composing
the *full* `Jwt` plugin only as its own setup step (to mint a real token
and fetch a real JWKS document as plain data) and a fake `HttpClient`
(mirroring `packages/oauth/test/OAuth.test.ts`'s own fake-client pattern)
to serve that data back to the module under test — which itself never
imports anything from the full plugin. Covers: valid-token acceptance;
tampered-signature rejection; wrong-`iss`/`aud` rejection; expired-token
rejection (`TestClock`); malformed-token rejection; and the unknown-`kid`
refetch path specifically (mint a token, call `KeyRing.rotateNow` to
produce a second real key, mint a second token with it, and prove the
verifier's first fetch — served only the pre-rotation JWKS — fails to
recognize the second token's `kid` until a second, real fetch succeeds
after the simulated "server rotated" JWKS update).

**Deviation found and fixed**: an early draft of `makeVerifier` carried an
explicit `Effect.Effect<Verifier, never, HttpClient.HttpClient>` return-type
annotation — caught against this repo's own standing no-explicit-return-
type rule before finalizing; removed, letting inference stand as it does
everywhere else in this package.

**Verification**: `pnpm --filter @effect-auth/jwt typecheck` clean,
`pnpm exec tsc -p tsconfig.test.json` clean, `pnpm --filter @effect-auth/jwt test` —
6 files, 33 tests, all passing (up from 27). `pnpm lint`/`pnpm format:check`
clean workspace-wide. No explicit `Effect`/`Layer` return-type annotations
on any new `const` in `src/`, no type assertions in `src/`.
