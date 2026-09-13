# 15 — Remote signing swap

**What to build:** an application that needs its private key material to
never leave a KMS/HSM can swap in a remote signer without touching
anything else about how this plugin works.

**Blocked by:** 07 — Key generation, persistence, and the KeyRing

**Status:** done

- [x] A formal signer interface: given bytes to sign and a `kid`, returns
      a signature — the plugin itself still assembles the compact JWS
      envelope (header + payload + signature), never delegating that
      assembly to the signer
- [x] The default local signer (ticket 07) is confirmed to conform to this
      same interface — no special-casing between local and remote
      elsewhere in the plugin
- [x] Under a remote-signing configuration, `privateKeyJwk` is never
      populated/stored — confirmed via test, not just by omission
- [x] Test: swap in a fake/test remote signer, sign and verify a token
      through it end to end, confirm the same shared verification logic
      (ticket 08) accepts a remotely-signed token identically to a
      locally-signed one

## Result

Done. `JwtCodec.ts` gained the formal `Signer` interface (`{ sign: (kid, alg, signingInput) => Effect<Uint8Array, JwtInvalidError> }`)
and `localSigner(privateKeyJwk)`, the WebCrypto-backed default that used to
be inlined directly in `sign`. `sign` itself now takes a `signer: Signer`
instead of a raw `privateKeyJwk` — it still owns all compact-JWS envelope
assembly (header/payload encoding, joining segments); the signer only ever
produces the raw signature bytes, exactly as scoped.

`RemoteSigner` (new): a `Context.Reference<Option.Option<Signer>>`
defaulting to `Option.none()` — the swappable layer an application
overrides with its own KMS/HSM-backed `Signer` implementation.

`Jwt.ts`'s `signClaims` now branches on the current key's own
`privateKeyJwk`: `Some` → `JwtCodec.localSigner`; `None` → whatever
`RemoteSigner` is configured, or `Effect.die` with a clear configuration-
error message if none is (a key with no local material and no remote
signer is a deployment mistake, not a recoverable runtime condition —
matches this ticket's own local-signer-no-special-casing requirement:
`JwtCodec.sign`/`verify` never know or care which kind of signer produced
a token).

`KeyRing.ts` gained `registerRemoteKey({kid, alg, publicKeyJwk})`: creates
a `SigningKeyRecords` row with `privateKeyJwk: Option.none()` — the public
key comes from the remote signer (the only party that ever held the
private half), supplied by the caller. **Documented, narrower scope**: this
is not invoked by `layerFromStore`'s own lazy-mint path, which always
mints locally — a deployment wanting remote signing from the very first
key must call `registerRemoteKey` before `KeyRing` is ever accessed (e.g.
at boot). A fully remote-first lazy-provisioning path (where `RemoteSigner`
itself could also generate a new key pair on demand) would need a richer
interface than this ticket scoped; flagged here rather than silently
assumed away.

**Tests** (`packages/jwt/test/RemoteSigning.test.ts`, new): a fake/test
remote signer (its own locally-generated keypair, exposing only the
`Signer` boundary — the plugin never touches its private half) signs a
token via `JwtCodec.sign` directly, and `JwtCodec.verify` accepts it
through the exact same path a locally-signed token goes through, no
special-casing; `KeyRing.registerRemoteKey` never populates
`privateKeyJwk` and the registered key is immediately `KeyRing.current`/
verifiable.

**Verification**: `pnpm --filter @effect-auth/jwt typecheck` clean,
`pnpm exec tsc -p tsconfig.test.json` clean, `pnpm --filter @effect-auth/jwt test`
— 5 files, 27 tests, all passing. `pnpm lint`/`pnpm format:check` clean
workspace-wide. No explicit `Effect`/`Layer` return-type annotations on any
new `const`, no type assertions in `src/`.
