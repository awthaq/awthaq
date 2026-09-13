# 00 — better-auth JWT/Bearer feature inventory and effect-auth's own current state

**Type:** research
**Status:** resolved
**Blocked by:** None — can start immediately

## Question

What is the full feature/contract surface of better-auth's Bearer and JWT
plugins, and — critically, since this repo already has partial groundwork —
what of that surface does effect-auth already have, versus what's actually
missing? This grounds every other ticket's scope.

## Answer

Source: `better-auth/07-session-extensions/03-bearer-and-jwt.md` (a local
contract-style reference doc, already vendored in this repo, covering both
plugins as "Part A" and "Part B"), cross-checked against this repo's own
`spec/models/08-jwt-bearer.md`, `spec/roadmap.md`, `archive/design/api-design-v4.md`
§11, `research/04-sessions-tokens.md` Q60/Q61, and the current source of
`packages/server/src/Authentication.ts` and `packages/oauth/src/Jwt.ts`.

### Bearer — already fully shipped, out of scope for this map

better-auth's bearer plugin is an **equivalence contract**: a before-hook
translates `Authorization: Bearer <token>` into the same cookie-carried
session lookup, with zero weakening of validity/revocation semantics
(Liskov-compliant substitution, per the reference doc's own §7). A
`set-auth-token` response header lets a bearer-only client learn about
token rotation it can't observe via `Set-Cookie`.

effect-auth's `packages/server/src/Authentication.ts` (BEH-EA-065–072)
**already implements exactly this**: `AuthenticationLive`/
`OptionalAuthenticationLive` both route `cookie` and `bearer` schemes
through the identical `resolvePrincipal` → `Sessions.verify` path (no
second validity check). The `set-auth-token` rotation-mirroring concern
doesn't even apply here: effect-auth's `Sessions.verify` idle-refresh is an
*expiry extension* on the same token, never a token-value rotation
(`research/04-sessions-tokens.md` Q45 recommendation 4 — "Sliding refresh
is an expiry update, not a token rotation"), so there is no rotated value a
bearer client could ever miss. **Bearer needs no further work.**

### JWT — the real gap

better-auth's JWT plugin ("Part B") issues a **self-contained,
stateless-verification representation** of an already-established session,
via three surfaces: an on-demand mint endpoint, an automatic
`set-auth-jwt` header mirrored onto every session-resolving response, and
an optional mode where the plugin's own signing machinery backs the base
session's own short-lived cookie-cache. Full feature list:

- **Claims** (§B.2): `iat`/`exp`/`iss`/`aud`/`sub` computed with a
  documented precedence (explicit payload value wins, else a
  plugin-computed default); `nbf`/`jti` passed through only if supplied;
  `sub` defaults to the session's user id; arbitrary extra claims via a
  developer-suppliable payload (`definePayload`).
- **Verification** (§B.2): requires a 3-segment token with a `kid`; fails
  closed to a single undifferentiated "invalid" outcome (never
  distinguishes *why*, to avoid leaking which check failed) covering
  format, missing `kid`, unknown `kid`, bad signature, `iss`/`aud`
  mismatch, expiry, or missing `sub`/`aud`; is **purely a function of the
  token's own bytes plus the currently-known JWKS/issuer/audience** — it
  never consults the session store (the load-bearing fact for the
  revocation tension below).
- **Signing keys and JWKS** (§B.3): local key generation (lazy-minted on
  first use) or a remote-signing callback; an explicit `kid` override that
  must already be provisioned (never auto-minted on miss); JWKS exposure
  disabled entirely when remote signing delegates key hosting elsewhere;
  never serializes private key material; a **rotation + grace period**
  model — a key stops signing new tokens at its rotation interval but
  keeps verifying (and stays listed in JWKS) for a configurable grace
  period afterward, so in-flight tokens don't suddenly break.
- **General-purpose primitives** (§B.4): `signJWT`/`verifyJWT` over an
  arbitrary caller-supplied payload, not necessarily tied to any session —
  reusing the same claims/key/rotation machinery, usable by other plugins
  (better-auth's own OAuth-provider extension is cited as a consumer).
- **The revocation tension** (§B.5), the single most important contract
  note in the source doc: a JWT is stateless by construction, so a session
  revoked *after* mint keeps validating via that JWT until `exp` — a
  **documented, deliberate weakening** relative to the base session
  contract's "revoked ⟹ immediately rejected" guarantee, licensed only
  because it's called out explicitly rather than presented as an
  equivalent representation. Mitigations: short `expirationTime` (default
  15 min), and an optional `sid` claim / cookie-cache re-anchoring mode
  that narrows (never eliminates) the exposure window.
- **`sessionCookieCache: "jwt"` mode** (§B.6): the base session's own
  rolling cookie-cache is signed/verified using this plugin's local JWKS —
  narrows §B.5's tension to `cookieCache.maxAge` instead of the JWT's own
  TTL, and fails open to a live session-store lookup on any cache-token
  verification failure. **No analog exists in effect-auth** — this
  codebase has no signed-cookie-cache concept for sessions at all, so this
  piece is architecturally N/A here, not a scope choice.

effect-auth's own state: **nothing exists yet.** `spec/models/08-jwt-bearer.md`
is a non-normative sketch only (`Jwt extends AuthPlugin.Service` with
`sign`/`verify`/`jwks`, contract exposing only `GET /auth/jwt/jwks`, no
mint endpoint in the sketch); `archive/design/api-design-v4.md` §11 sketches
key rotation via a `KeyRing extends LayerRef.Service<KeyRing>()("effect-auth/jwt/KeyRing",
{ layer: SigningKeys.layerFromStore, idleTimeToLive: "1 hour" })` pattern —
`LayerRef` exists in `../effect`'s source but **has no consumer anywhere in
this codebase yet** (this would be the first). `packages/oauth/src/Jwt.ts`
exists but solves a narrow, different problem: RS256-only verification of
*third-party-issued* OIDC `id_token`s for the OAuth plugin's own callback
flow — no signing, no JWKS-serving, no EdDSA, explicitly documented in its
own header comment as a deliberately minimal, narrowly-scoped module. It
is not a partial implementation of this plugin.

Also confirmed: `spec/overview.md`'s "Packages" table — the doc that
`spec/overview.md` itself calls authoritative for the 20-package layout —
**omits `@effect-auth/jwt` entirely** from its plugins row, even though
`spec/roadmap.md` M7 and `spec/models/08-jwt-bearer.md` both plan it. A
real spec inconsistency, not a deliberate cut (see the map's own charting
decision on fixing it).

### Scope this sets for the map

Full feature parity, minus the two pieces confirmed not applicable:
Bearer (already shipped) and `sessionCookieCache` mode (no analog to
attach to). Everything else in better-auth's Part B list above is in
scope, expressed through effect-auth's own primitives — `AuthPlugin.Service`,
`LayerRef.Service` for the key ring, `Api.Principal` (already carrying
`sessionId`/`actingAs`) as the sign input rather than a raw session lookup.
