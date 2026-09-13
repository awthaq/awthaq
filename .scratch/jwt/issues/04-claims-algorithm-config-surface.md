# 04 — Claims mapping, algorithm policy, and general-purpose signing primitives

**Type:** grilling
**Status:** resolved
**Blocked by:** None — can start immediately (grounded in ticket 00)

## Question

1. **Algorithm policy.** `spec/roadmap.md` fixes EdDSA as the default.
   Full parity with better-auth's own posture (RFC 8725-compliant
   allowlist, HS256 available only as an explicit, warned-about opt-in)
   suggests: EdDSA default, ES256 as a supported alternative (RFC 8725
   §3.1's other blessed asymmetric choice), no HS256 at all unless a real
   need surfaces later (shared-secret symmetric signing is a weaker
   default for a library whose whole selling point is third-party/JWKS
   verification) — confirm or refine.
2. **Claims precedence.** Confirm the same precedence rule as the
   reference doc's §B.2 (explicit payload value wins, else a
   plugin-computed default) and settle what "payload" means in
   effect-auth's own idiom — a config-level `definePayload`-equivalent
   Effect run at sign time, a per-call optional argument to `sign`, or
   both.
3. **`act`/`sid` population.** Should `sign` unconditionally mirror
   `Api.Principal`'s existing `sessionId` → `sid` and `actingAs` → `act`
   (RFC 8693-style) the same way `resolvePrincipal` already does for the
   ordinary session principal today (`packages/server/src/Authentication.ts`),
   or is this opt-in/configurable per plugin config?
4. **Default TTL and `iss`/`aud` defaults.** better-auth defaults to 15
   minutes and its own base URL for both `iss`/`aud`. Confirm effect-auth
   wants the same defaults, or different ones appropriate to this
   library's own config surface (e.g. does `iss`/`aud` come from an
   existing base-URL config already used elsewhere, or a new
   `JwtConfig`-only field).
5. **General-purpose `signJWT`/`verifyJWT` surface.** better-auth exposes
   these as "server-only endpoints" over arbitrary caller-supplied
   payloads, reused internally by its own OAuth-provider extension. For
   effect-auth: does this need an HTTP surface at all (an application's
   own TypeScript/Effect code can already call the plugin's service
   methods directly, no wire hop needed), or is an HTTP surface actually
   required for some real caller (e.g. a non-TS service in the same
   trust boundary)? If HTTP is needed, what gates it (an admin/service
   principal check, mirroring `Admin`'s own gating pattern)?


## Answer

**Algorithm policy**: EdDSA (Ed25519) default, ES256 as a supported
explicit alternative (both asymmetric, both RFC 8725-blessed) — no HS256.
Asymmetric-only is both the richer default (third-party JWKS verification
actually works) and the safer one; a shared-secret symmetric option adds a
configuration foot-gun with no offsetting benefit for this library's
actual use case, so it's cut rather than gated behind a warning the way
better-auth does.

**Claims precedence**: same rule as the reference doc's §B.2 — an explicit
value the caller supplies wins, else a plugin-computed default. Expressed
two ways: a `JwtConfig`-level `definePayload`-equivalent Effect (`(principal) => Effect.Effect<Record<string, unknown>>`,
defaulting to `{}`) run at sign time for defaults every token gets, and an
optional per-call payload argument on the general-purpose `signJWT`
primitive (ticket 04 §5) for one-off overrides — both feed the same
precedence-merge step.

**`act`/`sid` population**: unconditional, mirroring `resolvePrincipal`'s
existing, already-established behavior — `sid` always set from the
principal's `sessionId`; `act` set (RFC 8693-style) exactly when the
principal carries `actingAs`, omitted entirely otherwise (not `undefined`,
consistent with this codebase's existing `exactOptionalPropertyTypes`
convention). Not configurable — this isn't a place genuine flexibility
earns its keep; it's just correctly propagating data the principal already
carries.

**Default TTL / `iss` / `aud`**: 15 minutes default TTL, matching
better-auth. No shared "app base URL" config exists anywhere in this
codebase today (only `OAuthConfig.baseUrl`, plugin-local) — `Jwt` gets its
own `JwtConfig.issuer: string`, a **required** config value with no
default (deliberately stricter than `OAuthConfig.baseUrl`'s permissive
`"http://localhost:3000"` fallback: `iss` is a claim RFC 8725 requires
verifiers to check precisely, and a silently-wrong default here is a worse
failure mode than OAuth's redirect-convenience one). `aud` defaults to the
same value as `issuer` unless explicitly overridden.

**General-purpose `signJWT`/`verifyJWT` surface**: Effect-service methods
only, no HTTP surface. No real caller needing a wire hop has been
identified — an application's own TypeScript/Effect code can already call
these directly — and building an HTTP surface with no identified caller is
exactly the speculative-infrastructure case this project's own richness
preference explicitly carves out (see memory
`feedback-flexibility-over-complexity`'s own note on the enterprise-
attestation precedent). If a genuine non-TS same-trust-boundary caller
shows up later, adding an admin-gated HTTP wrapper around the existing
service methods is a small, backward-compatible addition, not a redesign.
