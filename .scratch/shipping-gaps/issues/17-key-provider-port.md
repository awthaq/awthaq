# 17 — Key-provider port + env-backed KMS-shaped layer

**What to build:** A new, swappable key-provider seam exists in
`@effect-auth/ports`, with a concrete env-key-backed implementation
usable in dev/test today, shaped so a real KMS can satisfy the same
interface later.

**Blocked by:** None — can start immediately

**Status:** done

## Result

New `@effect-auth/ports/KeyProvider` port: `KeyProviderShape` is
`currentKey: Effect<KeyMaterial>` (the key new ciphertext should be
written under) plus `getKey: (kid) => Effect<KeyMaterial, UnknownKeyId>`
(the key a specific existing ciphertext was written under — its own
recorded `kid`, not necessarily `currentKey`'s), where `KeyMaterial` is
`{ kid: string; key: Redacted.Redacted<Uint8Array> }`. Provider-agnostic
by construction — nothing in the interface names an env var or any other
storage mechanism — matching the `PasswordHasher`/`Mailer`/
`RateLimiter`/`SqlTransaction` port convention exactly (a real KMS
implementation satisfies the same shape later, no interface change
needed).

`layerEnv`: one key read once from the environment at layer
construction — `EFFECT_AUTH_ENCRYPTION_KEY` (required, base64, must
decode to exactly 32 bytes for AES-256) and
`EFFECT_AUTH_ENCRYPTION_KEY_ID` (optional, defaults to `"env"`), via
`effect/Config`'s `Config.String`/`Config.Redacted` (the capitalized
constructors — `Config.string` lowercase, hit and fixed in ticket 15,
isn't a real export). A missing key surfaces as a `Config.ConfigError`,
consistent with `PasswordHasher.layerArgon2id`/`layerScrypt`'s own
missing-config behavior; a present-but-malformed key (bad base64, wrong
byte length) dies instead, the same "fail loudly" choice
`Mailer.layerNoop` makes for a missing `Mailer`.

Contract tests (`packages/ports/test/KeyProvider.test.ts`, 4 tests):
`currentKey` returns 32 bytes of material under the configured `kid`;
`getKey` by that same `kid` returns identical material; `getKey` by an
unrecognized `kid` fails with `UnknownKeyId`; a missing
`EFFECT_AUTH_ENCRYPTION_KEY` fails the layer with a `ConfigError`. Tests
isolate env vars via `ConfigProvider.fromEnv({ env })` +
`ConfigProvider.layer(...)`, `Layer.provide`d under `layerEnv` — no
mutation of the real `process.env`, so tests stay parallel-safe.

No consumer wired — as scoped, that's tickets 18 (provider-token
encryption) and 19 (PKCE encryption), both now unblocked.

`pnpm test` — 577 passed, 2 skipped (was 573; +4 new); `pnpm
typecheck`/`pnpm lint`/`pnpm format:check` clean workspace-wide.

- [x] New key-provider port/interface added to `@effect-auth/ports` —
      provider-agnostic (not hardcoded to env vars in its own type),
      returning key material keyed by a rotatable `kid`
- [x] A concrete `layerEnv` (or similarly named) implementation satisfies
      the interface, backed by a single env-provided key for dev/test
- [x] Contract test proves: a caller can retrieve the current key by
      `kid`, and retrieval for an unknown `kid` fails with a typed error
- [x] No consumer wired yet — that's tickets 18/19; this ticket is the
      port plus one concrete layer only
