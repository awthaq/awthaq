# 07 — Key generation, persistence, and the KeyRing

**What to build:** signing keys are generated, persisted, and reachable
through a rotatable key ring — the foundation every later ticket signs or
verifies against.

**Blocked by:** 06 — Package setup and JwtConfig

**Status:** done

- [x] `jwt_signing_key` SQL table (`kid`, `alg`, `publicKeyJwk`,
      `privateKeyJwk`, `createdAt`, `rotatedAt`, `retiresAt`) plus a
      `layerMemory` twin, matching this codebase's existing
      persistence-stratum conventions
- [x] Private key material handled with `Redacted` the same way every
      other secret-shaped field in this codebase is; a local signer is the
      only path that ever populates `privateKeyJwk`
- [x] A `KeyRing` built on `LayerRef.Service` — the first real consumer of
      that primitive in this codebase — exposing the current signing key
      and the full (not-yet-retired) verification key set
- [x] Key generation supports both `algorithm` values (`EdDSA`/`ES256`)
      per `JwtConfig`
- [x] Lazily mints a first key on first use if none exists yet
- [x] Direct Effect-level test: a fresh `KeyRing` produces a key with the
      right shape (`kid` present, `publicKeyJwk` well-formed, no private
      material in anything that would be JWKS-serialized later)

## Result

Done. `jwt_signing_key` table (`kid` PK, `alg`, `publicKeyJwk`,
`privateKeyJwk`, `createdAt`, `rotatedAt`, `retiresAt`) with a
`layerMemory`/`layerSql` pair in `SigningKeyRecords.ts`, built directly
against `SqlSchema` mirroring `ImpersonationRecords.ts`'s own shape.
`privateKeyJwk` is `Option.Option<Redacted.Redacted<Jwk>>` — always `Some`
today (local signing is the only path built so far), `None` reserved for
ticket 15's remote-signing case. JWK objects are stored as JSON text via
plain `JSON.stringify`/`JSON.parse`, matching `@effect-auth/organization`'s
own convention for JSON-shaped columns rather than introducing
`Schema.parseJson` machinery this codebase doesn't otherwise use.
`findCurrent`/`listVerifiable` are the only two read operations built —
rotation's own write operation (`markRotated`-shaped) is left to ticket 11,
per this ticket's own scope; no speculative method was added ahead of the
ticket that actually needs it. Deliberately did **not** add a
`SigningKeyRecordNotFound`-style error class — nothing in this ticket's
scope ever fails a lookup (`findCurrent` returns `Option`), so a typed
error with no real caller would have been exactly the kind of speculative
infrastructure this codebase's own standing preference (see memory
`feedback-flexibility-over-complexity`'s speculative-generality carve-out)
warns against; add one if/when ticket 11 actually needs it.

`KeyRing.ts`: `SigningKeysCache` (a plain `Context.Service` snapshot —
`{current, verifiable}`) is built once by `layerFromStore`, reading
`SigningKeyRecords.findCurrent()` and lazily minting via WebCrypto
(`globalThis.crypto.subtle.generateKey`/`.exportKey`) if none exists yet —
EdDSA (`{name: "Ed25519"}`) or ES256 (`{name: "ECDSA", namedCurve: "P-256"}`)
per `JwtConfig.algorithm`, both real, distinct overloads of the DOM
`SubtleCrypto.generateKey` typing (verified: no `CryptoKey | CryptoKeyPair`
union ambiguity for either branch). `kid` generation reuses the existing
`Crypto.Crypto` port's `randomUUIDv7`, the same convention
`ImpersonationRecords.ts` already uses for its own row ids. `KeyRing`
itself is `LayerRef.Service<KeyRing>()("effect-auth/jwt/KeyRing", {layer: layerFromStore, idleTimeToLive: "1 hour"})`
— the first real consumer of `LayerRef` in this codebase, implementing
`archive/design/api-design-v4.md` §11's own sketch for real. Two ergonomic
module-level exports, `current`/`verifiable`, wrap `Effect.provide(..., KeyRing.get)`
so later tickets (08+) never have to touch `LayerRef`'s own API surface
directly — they just `yield* KeyRing.current`/`KeyRing.verifiable`.

WebCrypto failures (`generateKey`/`exportKey` rejecting) are treated as
defects (`Effect.orDie`), matching this codebase's existing convention for
platform-level crypto failures (the same treatment `Crypto.Crypto`'s own
`randomUUIDv7.pipe(Effect.orDie)` calls already get throughout this
codebase) rather than a typed, per-caller-recoverable error — a signing key
failing to generate is an environment problem, not something a caller of
`sign`/`verify` should ever have to handle. A small `KeyGenerationError`
`Data.TaggedError` still wraps the raw cause before the `orDie`, since this
repo's own tsc plugin warns (`unknownInEffectCatch`/`globalErrorInEffectCatch`)
against an untyped or bare-`Error` catch channel even when the value is
immediately died — cheap to add, keeps the warning-free bar this codebase
holds elsewhere.

**Verification**: `pnpm --filter @effect-auth/jwt typecheck` clean (no
`tryPromise` catch-channel warnings); `pnpm exec tsc -p tsconfig.test.json`
clean; `pnpm --filter @effect-auth/jwt test` — `KeyRing.test.ts` runs the
same contract suite against both `layerMemory` and `layerSql` (mirroring
`ImpersonationRecords.test.ts`'s own `suite()` pattern): a fresh `KeyRing`
mints a well-formed EdDSA key (`kid` non-empty, `kty: "OKP"`, no `d` field
on the public JWK, a private JWK present), the minted key persists as the
store's current row, `verifiable` includes it; a fourth test confirms
`algorithm: "ES256"` mints a `kty: "EC"` key instead. 7 tests total for
this ticket (plus ticket 06's own 2, 9 in the package overall) — all
passing. `pnpm lint`/`pnpm format:check` clean workspace-wide.
