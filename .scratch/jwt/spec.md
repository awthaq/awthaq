# Jwt — full-featured JWT session representation

**Status:** ready-for-agent
**Tracker:** `.scratch/jwt/` (map: `map.md`; resolved decision tickets: `issues/00` through `issues/05`)

## Problem Statement

A session in effect-auth lives as an opaque, server-side-verified token
(`Sessions`) — the right default, but unusable by two real classes of
caller: a native/desktop client or machine-to-machine caller that can't
rely on cookie storage the way a browser can (already solved today, by the
existing `bearer` scheme), and — the actual gap — a **downstream service**
that needs to know who's calling without a round trip to effect-auth's own
session store at all. Today there is no way to hand such a service a
credential it can verify on its own, and no way for effect-auth's own
users to mint one.

## Solution

A `Jwt` plugin that mints short-lived, self-contained, cryptographically
signed tokens representing an already-authenticated caller, and exposes
everything a downstream verifier needs to check one without ever calling
back into effect-auth: a `GET /auth/jwt/jwks` endpoint, an explicit mint
endpoint, automatic mirroring of a fresh token onto every authenticated
response, and a standalone lite-verifier module a foreign service can
depend on with zero footprint from the rest of this ecosystem. Full
feature parity with better-auth's own JWT plugin, expressed through
effect-auth's own primitives — `AuthPlugin.Service`, `LayerRef.Service`
for key rotation, and one small, additive, optional core hook that makes
the automatic-mirroring behavior actually possible.

`Bearer` — the *other* half of better-auth's pairing this effort was
originally scoped to cover — needs no work: `packages/server/src/Authentication.ts`
(BEH-EA-065 through 072) already resolves an `Authorization: Bearer <token>`
credential through the identical `Sessions.verify` path a cookie uses, with
no weakening of validity or revocation semantics. This spec covers `Jwt`
only.

## User Stories

1. As an application developer, I want to install a `Jwt` plugin into my
   `Auth.make([...])` composition, so that my users' sessions can be
   represented as signed, third-party-verifiable tokens without writing
   any signing/verification code myself.
2. As an authenticated user (browser or bearer client), I want to call an
   explicit endpoint and receive a fresh JWT representing my current
   session, so that I can hand it to a downstream service that needs proof
   of who I am.
3. As an authenticated user, I want every successful response from any
   authenticated endpoint — not just a dedicated mint call — to also carry
   a fresh JWT, so that a client that always inspects a given response
   header never needs a separate round trip just to get one.
4. As a downstream/resource-server developer who does not run
   `effect-auth` at all, I want to verify a JWT myself, using only its
   bytes and a published JWKS document, so that I never have to add this
   library as a dependency of my own service just to check who's calling.
5. As that same downstream developer, I want the verifier I depend on to
   have a genuinely small import graph — no `AuthPlugin`, no `Sessions`,
   no database awareness — so that adding it to my service doesn't drag in
   an entire auth framework.
6. As an application developer, I want `Jwt`'s default algorithm to be
   EdDSA (Ed25519), so that I get a modern, fast, well-regarded default
   without configuring anything.
7. As an application developer who needs a different asymmetric algorithm
   for compatibility with an existing verifier, I want ES256 available as
   an explicit alternative, so that I'm not locked into EdDSA alone.
8. As an application developer, I want no symmetric (HS256-style) signing
   option at all, so that I can't accidentally configure a shared-secret
   scheme that defeats the point of third-party verification.
9. As an application developer, I want signing keys to persist across
   restarts, so that a redeploy doesn't invalidate every JWT my users are
   currently holding.
10. As an application developer, I want signing keys to rotate
    automatically on a schedule, so that a long-lived deployment doesn't
    keep signing with the same key forever.
11. As a security-conscious operator, I want to be able to force an
    immediate key rotation outside the normal schedule (e.g. on suspected
    compromise), so that I'm not stuck waiting for the next scheduled
    rotation.
12. As a downstream verifier, I want a rotated-out key to keep verifying
    (and stay listed in JWKS) for a grace period after it stops signing
    new tokens, so that tokens issued just before rotation don't suddenly
    become unverifiable.
13. As an application developer, I want the option to delegate signing to
    an external KMS/HSM rather than storing private key material in my own
    database, so that I can meet my own organization's key-custody
    requirements.
14. As an application developer using the default local signer, I want
    private key material handled with the same care as every other secret
    in this codebase, so that a database leak doesn't trivially expose
    signing keys in the clear.
15. As a JWT verifier (mine or a downstream service's), I want signature
    verification to check an explicit algorithm allowlist rather than
    trusting the token's own `alg` header, so that an attacker can't
    downgrade or confuse the verification algorithm.
16. As a JWT verifier, I want `iss`/`aud`/`exp` checked on every
    verification, so that a token minted for a different purpose or
    audience — or one that's simply expired — is rejected.
17. As an application developer, I want to configure my own `issuer`
    (required, no silent default) and have `audience` default to it unless
    I override it, so that I can't accidentally ship an insecure
    unconfigured issuer claim to production.
18. As an application developer, I want the token's `sub` claim to be the
    authenticated user's id, its `sid` claim to be the underlying session
    id, and its `act` claim to be populated automatically whenever the
    caller is impersonating (mirroring effect-auth's existing `actingAs`
    principal shape), so that a downstream verifier gets the same identity
    picture effect-auth's own session-resolution already provides.
19. As an application developer, I want to supply my own default extra
    claims via a config-level payload function, so that I can add
    application-specific data (e.g. a tenant id) to every token without
    hand-rolling claims assembly.
20. As an application developer building an internal, trusted service
    integration, I want a general-purpose `signJWT`/`verifyJWT` pair that
    operates on an arbitrary payload — not necessarily tied to a session at
    all — so that I can reuse the plugin's signing/key/rotation machinery
    for my own token needs instead of building a second one.
21. As that same developer, I want those general-purpose primitives to be
    plain Effect service methods, callable directly from my own
    TypeScript code, not a wire endpoint I have to call over HTTP for an
    in-process need.
22. As a security auditor, I want it documented plainly, in one place, that
    a JWT keeps verifying until its own `exp` even if the underlying
    session is revoked in the meantime, so that nobody mistakes a JWT for
    carrying the same revocation guarantee a cookie/bearer session does.
23. As an application developer worried about that exact tension, I want
    an opt-in live-revocation-check function (`verifyLive`), distinct from
    the ordinary stateless `verify`, so that I can re-anchor to the live
    session store for high-value verification paths that run inside my own
    effect-auth-hosting process.
24. As a downstream service using the lite verifier, I want it made clear
    that no live-revocation check is available to me at all, so that I
    correctly treat any JWT I verify as valid-until-`exp`, full stop.
25. As an application developer, I want `Jwt`'s tables (`jwt_signing_key`)
    to follow this codebase's existing table-prefixing and
    memory/SQL-persistence-twin conventions, so that the plugin composes
    the same way every other plugin already does.
26. As an application developer, I want the JWKS endpoint to never expose
    private key material under any configuration (local or remote
    signing), so that a misconfiguration can't leak a signing key over
    HTTP.
27. As a plugin author for a *future* plugin, I want the new
    `PostAuthResponseHook` core slot to default to a true no-op when `Jwt`
    isn't installed, so that installing unrelated plugins never changes
    response shape or behavior.
28. As an application developer, I want the explicit mint endpoint to
    require an authenticated caller (via the existing cookie/bearer
    middleware) and accept no request payload, so that a caller can never
    inject arbitrary claims into their own token over the wire.
29. As a test author, I want the plugin's contract to be stable across
    every documented config option value, so that `runPluginContractTests`
    catches an accidental contract break the same way it does for every
    other plugin.
30. As a test author, I want key rotation and expiry behavior to be
    testable deterministically, so that I can assert "a token minted at
    t0 still verifies at t0+14m and fails at t0+16m" without a real clock.
31. As an application developer, I want `spec/overview.md`'s own Packages
    table corrected to list `@effect-auth/jwt`, so that the spec's own
    authoritative package inventory stops omitting a plugin
    `spec/roadmap.md` already plans.

## Implementation Decisions

**Package.** A new `@effect-auth/jwt` plugin package, added to
`spec/overview.md`'s Packages table (a correction to an existing
omission). Depends on the ordinary plugin toolkit (`server`, `core`,
`sql`, `ports`, `api`) — no dependency on `qadi` or any other plugin.
Exposes a second, subpath entry point (`@effect-auth/jwt/verify` or
similarly named) whose own import graph is kept clear of `AuthPlugin`,
`Sessions`, and every other core service — this is the "lite verifier" a
downstream, non-`effect-auth` service can depend on in isolation.

**Plugin shape.** `Jwt extends AuthPlugin.Service<...>` exposing `sign`
(from the current `Principal`), `verify` (stateless), `verifyLive` (an
additional export requiring `Sessions`, re-checking the token's `sid`
against the live session store), `signJWT`/`verifyJWT` (general-purpose,
arbitrary-payload variants), and `jwks` (the current, non-expired-past-
grace key set). `tables: ["jwt_signing_key"]`. `dependsOn: []` — nothing
about minting or verifying requires another plugin to be installed.

**Config (`JwtConfig`).** `issuer: string` — required, no default value
(deliberately stricter than the permissive-default pattern
`OAuthConfig.baseUrl` uses, since an unconfigured or wrong `iss` is a
higher-severity failure mode for a claim RFC 8725 requires verifiers to
check precisely). `audience` — defaults to `issuer`, overridable.
`algorithm` — `"EdDSA" | "ES256"`, default `"EdDSA"`; no HS256 option
exists at all. `ttl` — `Duration`, default 15 minutes. `keyRotationInterval` —
`Duration`, default 90 days. `keyGracePeriod` — `Duration`, default 30
days. `definePayload` — an optional `(principal) => Effect.Effect<Record<string, unknown>>`
supplying default extra claims merged under the precedence rule below.
`signer` — a swappable layer defaulting to local key generation/storage;
overridable with a remote-signing implementation for KMS/HSM-backed
deployments.

**Claims.** Registered claims (`iat`, `exp`, `iss`, `aud`, `sub`) are
always plugin-computed from the current `Principal`/config and are never
overridable at the mint-endpoint call site (no request payload accepted
there at all). `sub` is the principal's user id; `sid` is always the
principal's `sessionId`; `act` is populated, RFC 8693-style, exactly when
the principal carries `actingAs`, and omitted entirely otherwise (not
`undefined`). Extra claims follow a precedence rule: an explicit value
supplied to the general-purpose `signJWT` call wins; otherwise, whatever
`definePayload` computed for that principal; otherwise absent. `nbf`/`jti`
are carried through only if explicitly supplied to `signJWT`.

**Verification.** `verify` checks: well-formed 3-segment token with a
`kid`; algorithm against the configured allowlist (never trusting the
token's own declared `alg` without cross-checking); signature against the
matching JWKS key; `iss`/`aud` against configured values; `exp` against
the current time (via the ambient `Clock`, so tests can use `TestClock`);
presence of `sub`. Every distinct failure mode collapses to one
undifferentiated invalid-token error — mirroring better-auth's own
posture of not leaking which specific check failed. `verifyLive` performs
every `verify` check and then additionally confirms the `sid` claim still
names a live, unrevoked session — the mitigation for JWT's inherent
revocation-weakening (documented explicitly, not silently assumed away)
— and is only ever available where `Sessions` is reachable, i.e. never
from the lite verifier.

**Key management.** A `KeyRing`, built on `LayerRef.Service` (the first
real consumer of that primitive in this codebase), backed by a
`jwt_signing_key` SQL table (`kid`, `alg`, `publicKeyJwk`, `privateKeyJwk`
— `Redacted`-handled, populated only under local signing — `createdAt`,
`rotatedAt`, `retiresAt`) with a `layerMemory` twin for tests. Rotation is
both automatic (time-based, per `keyRotationInterval`) and explicitly
triggerable (a `KeyRing.refresh`-shaped operation, reachable from the
planned CLI per `spec/roadmap.md` M6). A key past `rotatedAt` stops
signing new tokens but keeps verifying, and stays listed in JWKS, until
`retiresAt` (`rotatedAt + keyGracePeriod`). The JWKS endpoint never
serializes private key material, under any signing configuration.
Remote signing is a layer swap: the remote signer signs raw bytes and
returns a signature plus its `kid`; the plugin itself still assembles the
compact JWS envelope, so the shared claims/verification module works
identically regardless of which signer produced a given token.

**Automatic response mirroring.** A new, small, additive, optional core
slot — `PostAuthResponseHook`, a `Context.Reference` defaulting to an
identity no-op — is consulted once inside
`AuthenticationLive`/`OptionalAuthenticationLive`
(`packages/server/src/Authentication.ts`), immediately after a successful
`resolvePrincipal`, and its result applied to the outgoing response before
it's returned. This mirrors the existing overridable `PrincipalResolver`
pattern already used in that same file — not a new subsystem. `Jwt`'s own
layer overrides this reference to mint a token for the resolved principal
and attach it as a response header on every authenticated response, across
every installed plugin, with no per-plugin opt-in required. This is a real
core touch, scoped deliberately small: one new reference and a few lines
in one existing file, no change to any existing contract's behavior when
`Jwt` isn't installed.

**Explicit mint endpoint.** `GET /auth/jwt/token`-shaped, gated by the
existing `Authentication` middleware (cookie or bearer), no request
payload. Returns the same shape of token the response-mirroring path
would have attached.

**JWKS endpoint.** `GET /auth/jwt/jwks`, unauthenticated (JWKS is public
by definition), returning every key not yet past its `retiresAt`.

## Testing Decisions

Good tests here assert externally observable behavior — token
verifiability, claim contents, timing-based validity, and response shape —
never internal key-storage representation or signing-library internals.

Two seams, mirroring and extending this codebase's own established
pattern:

1. **`packages/jwt/test/AuthHttp.test.ts`** — the same wire-level seam
   every other plugin already uses (`HttpApiTest`, in-memory client, no
   real server/database), extended here to prove two things a purely
   internal test couldn't: (a) the mint endpoint and JWKS endpoint work
   end to end — mint a token while authenticated, fetch JWKS, verify the
   token against it, confirm claims; and (b) the automatic response-
   mirroring mechanism genuinely works *generically* — installing `Jwt`
   alongside an unrelated plugin (e.g. `Password`) and hitting one of
   *that* plugin's own authenticated endpoints, asserting the mirrored-JWT
   response header is present, proves this isn't special-cased to `Jwt`'s
   own endpoints. Also carries this plugin's own
   `runPluginContractTests` block (table prefixes, no host-id collision,
   deterministic migrations, contract stability across every documented
   config value), matching `packages/admin/test/AuthHttp.test.ts`'s own
   role.
2. **A dedicated lite-verifier test file** (e.g.
   `packages/jwt/test/verify.test.ts`), deliberately *not* routed through
   `TestAuth`/plugin composition at all — it can't be, since the lite
   verifier has zero dependency on `AuthPlugin` by design. Feeds it a
   really-signed token (produced via the full plugin's own `sign` in a
   setup step) and a real JWKS document, and exercises: valid token
   accepted; tampered signature rejected; wrong `iss`/`aud` rejected;
   expired token rejected (via `TestClock`); unknown `kid` rejected;
   malformed token rejected. This is the proof that a genuinely
   `effect-auth`-unaware consumer's actual experience works, which the
   wire-level seam structurally cannot exercise.

Key rotation/grace-period behavior is tested via `TestClock`: advance past
`keyRotationInterval`, confirm a key stops signing but still verifies;
advance past `keyRotationInterval + keyGracePeriod`, confirm it no longer
verifies and drops out of JWKS.

`verifyLive`'s revocation-reanchoring behavior is tested by minting a
token, revoking the underlying session, and confirming `verify` still
succeeds (the documented weakening) while `verifyLive` now fails.

## Out of Scope

- **`Bearer`** — already fully implemented in core; not part of this
  effort at all (see `.scratch/jwt/issues/00-better-auth-jwt-bearer-feature-inventory.md`).
- **`sessionCookieCache: "jwt"` mode** — no analog exists in effect-auth's
  session architecture (no signed-cookie-cache concept to attach a signer
  to).
- **An HTTP surface for the general-purpose `signJWT`/`verifyJWT`
  primitives** — Effect-service-only for now; no identified caller needs
  a wire hop. Revisit if one appears.
- **Merging or sharing code with `packages/oauth/src/Jwt.ts`** — that
  module solves a narrow, different problem (RS256-only third-party
  `id_token` verification) and stays independent. A real, low-priority
  duplication, not blocking anything.
- **A 21st top-level package for the lite verifier** — it ships as a
  subpath export of `@effect-auth/jwt` instead.
- **Symmetric (HS256) signing** — cut entirely, not merely defaulted off.

## Further Notes

- This spec's own destination decision (recorded in `.scratch/jwt/map.md`)
  deliberately stays a `.scratch/jwt/spec.md`-style artifact rather than
  escalating to a formal `spec/behaviors/` file with a new `BEH-EA` range,
  even though it does touch core — the touch (one optional reference, a
  few lines in one file) is proportionate to `Organization`'s own
  no-core-touch precedent in spirit, not `Admin`'s multi-file
  `Sessions`/`Authentication`/SQL-model rework. If implementation reveals
  `PostAuthResponseHook` needs to be bigger than sketched here, that's
  grounds to revisit this call, not silently absorb the scope creep.
- The user confirmed, across this map's own grilling rounds, a standing
  preference for the richest available option at every fork — including,
  notably, overriding two points this session had explicitly framed as
  genuine architecture forks rather than mere complexity dials (automatic
  response mirroring, and a standalone lite verifier). See memory
  `feedback-flexibility-over-complexity` for the fuller account.
- `spec/overview.md`'s Packages table correction (adding
  `@effect-auth/jwt`) should land as part of this effort's own first
  ticket, not as a separate cleanup — it's small and directly relevant.
