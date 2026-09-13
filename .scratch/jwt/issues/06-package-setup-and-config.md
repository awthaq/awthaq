# 06 — Package setup and JwtConfig

**What to build:** the `@effect-auth/jwt` package exists, installs into
`Auth.make([...])` as an empty-but-legal plugin, and its configuration
surface is fully typed and ready for later tickets to build against.

**Blocked by:** None — can start immediately

**Status:** done

- [x] `@effect-auth/jwt` package scaffolded following this repo's standard
      per-package template (package.json, tsconfig, vitest config, README),
      including a second, subpath export entry point intended for the
      lite verifier (ticket 13) whose own import graph must stay clear of
      `AuthPlugin`/`Sessions`/core from day one
- [x] `Jwt extends AuthPlugin.Service<...>` — an empty shape for now,
      `dependsOn: []`, `tables: ["jwt_signing_key"]`, composes cleanly into
      `Auth.make([Jwt])` with no other plugins installed
- [x] `JwtConfig`: `issuer` (required, no default), `audience` (defaults to
      `issuer`), `algorithm` (`"EdDSA" | "ES256"`, default `"EdDSA"`, no
      HS256 option exists at all), `ttl` (`Duration`, default 15 minutes),
      `keyRotationInterval` (`Duration`, default 90 days), `keyGracePeriod`
      (`Duration`, default 30 days), `definePayload` (optional
      `(principal) => Effect.Effect<Record<string, unknown>>`, default
      `{}`)
- [x] `spec/overview.md`'s Packages table gets `@effect-auth/jwt` added to
      its plugins row — the omission ticket 00 of this effort's wayfinder
      map found
- [x] `AuthComposition.test.ts`-style test: the empty plugin composes,
      manifest's `tables`/`dependsOn` are correct

## Result

Done. `packages/jwt` scaffolded exactly mirroring `packages/admin`'s own
template (`package.json`, `tsconfig.json`/`tsconfig.src.json`,
`vitest.config.ts`, `README.md`) — including the `"./*"` wildcard export
entry already present in that template, which covers the reserved
`@effect-auth/jwt/verify` subpath (ticket 13) with no special-casing
needed; a placeholder `src/verify.ts` was added so that export isn't
dangling in the meantime.

`Jwt extends AuthPlugin.Service<Jwt, Record<string, never>>()("jwt", {...})`
— `dependsOn: []`, `tables: ["jwt_signing_key"]`, `contract: HttpApi.make("auth")`
with no `.add()` call, the exact same "real, zero-group `HttpApi<"auth", never>`"
pattern `@effect-auth/roles`'s own `Roles.ts` uses for a plugin with no
endpoints yet. `JwtShape` is `Record<string, never>` (not `{}`, which this
codebase's `ban-types`-shaped lint conventions disfavor) — genuinely empty,
per this ticket's own scope; `sign`/`verify`/etc. are ticket 08 onward.

`JwtConfig` was deliberately split into its own module (`JwtConfig.ts`)
rather than living in `Jwt.ts` — `KeyRing.ts` (ticket 07) needs
`algorithm`/`keyRotationInterval`/`keyGracePeriod` from it, and putting the
config in `Jwt.ts` would have set up a real circular import once `Jwt.ts`
itself starts importing `KeyRing.ts` (ticket 08 onward). `JwtConfig` is a
plain `Context.Service` (no default), not a `Context.Reference` — the
first config in this codebase to use that shape — since `issuer` has no
sensible default per the spec's own decision; `config({issuer, ...})`'s
own parameter type (`{readonly issuer: string} & Partial<Omit<JwtConfigShape, "issuer">>`)
enforces that at the call site, not just in a doc comment.

`spec/overview.md`'s Packages table row now lists `jwt` alongside the other
plugins.

**Discovery, not in the original ticket checklist**: `Auth.make([Jwt.Jwt])`
alone throws `EmptyPluginTuple` — a plugin contributing zero HTTP groups
makes the *whole* composed `HttpApi` empty, which `Auth.ts`'s own
`composeApi` refuses (see its own header comment). This is not a bug in
this ticket's work; it's the exact same situation `@effect-auth/roles`'s
own `AuthComposition.test.ts` already documents and tests for. Mirrored
that file's pattern exactly: one test asserts the empty-tuple throw, a
second composes `Jwt` alongside a minimal one-endpoint `Ping` toy plugin to
prove the real manifest entry composes correctly. Worth noting for ticket
09 (JWKS endpoint): once `Jwt`'s contract gains a real group, `Auth.make([Jwt.Jwt])`
alone will start working, and this test's own "fails alone" case will need
updating then (not before).

**Verification**: `pnpm --filter @effect-auth/jwt typecheck` clean;
`pnpm exec tsc -p tsconfig.test.json` clean; `pnpm --filter @effect-auth/jwt test`
— 2 files, 9 tests, all passing (7 of those are ticket 07's own KeyRing
tests, committed together); `pnpm lint`/`pnpm format:check` clean
workspace-wide.
