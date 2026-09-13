# 05 — Key rotation, persistence, and remote signing

**Type:** grilling
**Status:** resolved
**Blocked by:** None — can start immediately (grounded in ticket 00)

## Question

This map has already decided: signing keys persist to SQL (a
`jwt_signing_key` table plus a `layerMemory` test twin, matching every
other stateful plugin in this codebase), the key ring is built on
`LayerRef.Service` (the first real consumer of that v4 primitive, per
`archive/design/api-design-v4.md` §11's `KeyRing`/`SigningKeys.layerFromStore`
sketch), remote signing is a swappable layer rather than a new
`@effect-auth/ports` port, and `verify` gets an opt-in `sid`-based live
revocation check (the mitigation `better-auth/07-session-extensions/03-bearer-and-jwt.md`
§B.5/§B.6 call for). Still open:

1. **Rotation trigger.** Is key rotation admin/CLI-triggered (e.g. a
   `jwt rotate-keys` CLI command calling something like `KeyRing.refresh`),
   time-based/automatic (a scheduled interval the plugin enforces itself),
   or both — and how does that interact with `LayerRef.Service`'s own
   `idleTimeToLive`, which governs cache release/refresh, not necessarily
   a rotation *schedule*?
2. **Rotation interval and grace period defaults.** better-auth ships a
   configurable rotation interval plus a default 30-day grace period
   (keys keep verifying, stay listed in JWKS, but stop signing new tokens
   once rotated). Confirm effect-auth wants the same default or a
   different one.
3. **`jwt_signing_key` schema.** At minimum: `kid`, `alg`, public key
   material, private key material (how encoded/protected at rest — this
   touches this codebase's existing secret-handling conventions,
   `Config.Redacted` and friends), `createdAt`, and however "rotated but
   still in grace" vs. "fully retired" gets represented (a timestamp pair,
   or a status enum).
4. **Remote-signing callback interface.** For a KMS/HSM-backed signer to
   be a real drop-in layer swap (not a partial escape hatch), what's its
   actual boundary — does it sign raw bytes and return a signature (the
   plugin still assembles the JWS/JWT envelope), or does it own the whole
   compact-JWS assembly? The former composes more cleanly with the shared
   claims/verification logic (ticket 04); confirm that's the intended
   shape.
5. **`sid` live-check shape.** Is the opt-in a boolean config flag on
   `verify` (requiring `Sessions` in `verify`'s own `R`, meaning it can
   only ever exist on the full in-process `Jwt` service — never the lite
   verifier, per ticket 03), a second, separately-named exported function
   (`verify` vs. `verifyLive`), or a per-call option? Confirm the shape
   that keeps the stateless/stateful distinction obvious at the type
   level, not just in documentation.


## Answer

**Rotation trigger**: both — an automatic, time-based rotation interval
the plugin enforces itself (not merely `LayerRef`'s own `idleTimeToLive`,
which governs cache release/refresh, a different concern) and an
explicit, admin/CLI-triggerable `KeyRing.refresh` for an immediate,
out-of-band rotation (e.g. suspected key compromise). `idleTimeToLive`
still applies underneath, governing when an idle `LayerRef` releases its
current layer instance — orthogonal to the rotation schedule itself.

**Rotation interval and grace period defaults**: 90-day signing lifetime
(a key stops signing new tokens once reached), 30-day grace period
afterward (matching better-auth's own default) during which the key keeps
verifying and stays listed in JWKS, so tokens signed just before rotation
don't immediately break.

**`jwt_signing_key` schema**: `kid` (primary key), `alg`, `publicKeyJwk`
(JSON, always safe to serialize), `privateKeyJwk` (JSON; encoded/protected
at rest using this codebase's existing secret-handling conventions —
`Redacted` at the application boundary the same way every other
credential-shaped field in this codebase is handled), `createdAt`,
`rotatedAt` (nullable — set when the key stops signing new tokens),
`retiresAt` (nullable — `rotatedAt + gracePeriod`, computed at rotation
time rather than recomputed per read). A local, non-remote signer is the
only path that populates `privateKeyJwk`; a remote-signing configuration
never stores private key material at all (mirroring the reference doc's
own §B.3 rule that JWKS/storage never carries private material regardless
of signing mode).

**Remote-signing callback interface**: signs raw bytes and returns a
signature (plus confirms/derives its own `kid`) — the plugin itself still
assembles the compact JWS envelope (header + payload + signature). This
composes cleanly with the one shared claims/verification module (ticket
03's answer) regardless of which signer produced a given token, and keeps
a KMS/HSM integration to exactly "sign these bytes," the narrowest
possible boundary.

**`sid` live-check shape**: a second, separately-named exported function —
`verifyLive` — built on top of the stateless `verify`, requiring `Sessions`
in its own `R` (so the stateless/stateful distinction is visible at the
type level, not just in documentation, and so it cannot accidentally exist
on the lite verifier, which never has `Sessions` available at all per
ticket 03's answer). Not a boolean flag on `verify` itself — that would
make `verify`'s own service-requirement type conditional on a runtime
value, which Effect's type system can't express cleanly; a distinct
function name is the idiomatic equivalent this codebase already reaches
for elsewhere (e.g. `Authentication` vs `OptionalAuthentication` as two
named variants rather than one flag-parameterized function).
