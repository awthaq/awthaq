# Jwt plugin — full better-auth JWT feature parity

## Destination

A spec at `.scratch/jwt/spec.md` (produced via `/to-spec`, mirroring the
`Organization` plugin's own path rather than `Admin`'s core-touching one)
for a full-featured `Jwt` plugin — self-contained, EdDSA-first signing with
a rotating `LayerRef`-backed key ring, a `GET /auth/jwt/jwks` endpoint,
general-purpose `signJWT`/`verifyJWT` primitives, and a standalone
lite-verifier surface for downstream services that never install
`effect-auth` at all — matching better-auth's JWT plugin's full capability
set (see [00 — better-auth JWT/Bearer feature inventory](issues/00-better-auth-jwt-bearer-feature-inventory.md))
but expressed through effect-auth's own primitives. Ready to hand to
`/to-tickets` once resolved. `Bearer` is explicitly **not** part of this
destination — see Out of scope.

## Notes

- Domain: `spec/models/08-jwt-bearer.md` (non-normative sketch),
  `spec/roadmap.md` M7, `archive/design/api-design-v4.md` §11 (`LayerRef`/
  `KeyRing` sketch), `research/04-sessions-tokens.md` Q60/Q61,
  `better-auth/07-session-extensions/03-bearer-and-jwt.md` (the vendored
  contract-style reference this map's research ticket is grounded in).
- Precedent: `Organization` (`.scratch/organization/`) is this map's
  closest analog — a self-contained M7 plugin needing no core changes,
  spec'd via `.scratch/<feature>/spec.md` rather than a formal
  `spec/behaviors/` file. `Admin` (`.scratch/admin/`) is the other
  pattern (core-touching, formal `BEH-EA` range) — ticket 02 may yet pull
  this map toward that pattern instead, if the response-mirroring
  mechanism forces a core change; watch for that.
- Standing preference: ship the richest/most feature-complete option at
  every fork — reconfirmed verbatim a third time during this map's own
  grilling rounds, this time overriding two questions this session had
  explicitly framed as genuine architecture forks rather than mere
  richness dials (see memory `feedback-flexibility-over-complexity`'s own
  correction note). Treat any further repeat of this phrase the same way.
- Skills every session should consult: `/grilling`, `/domain-modeling`.

## Decisions so far

- [00 — better-auth JWT/Bearer feature inventory](issues/00-better-auth-jwt-bearer-feature-inventory.md) — research: full feature/contract inventory of better-auth's Bearer and JWT plugins, cross-checked against what effect-auth already has. Bearer is already fully shipped in core (`Authentication.ts`, BEH-EA-065–072) with no weakening — nothing left to build there. `sessionCookieCache` mode has no analog in this codebase's architecture. Everything else in better-auth's JWT surface is the real gap and this map's actual scope.
- Destination and initial scope (this map's own charting round, resolved directly — no ticket): destination narrowed to `Jwt` only; artifact is `.scratch/jwt/spec.md`; full better-auth feature parity minus Bearer (done) and `sessionCookieCache` (N/A); `spec/overview.md`'s Packages table gets `@effect-auth/jwt` added (a correction — the table omits it despite `spec/roadmap.md` planning it); the key ring is built on `LayerRef.Service` now, as the design was always meant to (first real consumer of that v4 primitive in this codebase); signing keys persist to SQL (`jwt_signing_key` table, `layerMemory` twin), matching every other stateful plugin's convention; remote signing is a swappable layer, not a new `@effect-auth/ports` port; `Jwt.verify` gets an opt-in `sid`-based live revocation check (the documented mitigation for JWT's inherent revocation-weakening); a standalone lite verifier (no `AuthPlugin`/`Sessions` dependency) ships alongside the full plugin, since a downstream service with zero effect-auth footprint is the actual use case; `packages/oauth/src/Jwt.ts` stays independent, not merged/shared with the new plugin (a real but low-priority duplication, not blocking anything).
- [02 — Mint delivery mechanism](issues/02-mint-delivery-mechanism.md) — no existing global response-middleware hook exists in `AuthHttp.ts`; the real mechanism is a new, small, additive optional core slot (`PostAuthResponseHook`, consulted once inside `AuthenticationLive`/`OptionalAuthenticationLive` after `resolvePrincipal` succeeds, mirroring the existing `PrincipalResolver` pattern) that `Jwt`'s own layer overrides to mirror a JWT onto every authenticated response, across every plugin, automatically. This **is** a core touch — `packages/server/src/Authentication.ts` gains a few lines and core gains one new reference — but it's proportionate (additive, no existing contract changes when unused), so the destination artifact stays `.scratch/jwt/spec.md` rather than escalating to a formal `spec/behaviors/` file. The explicit `GET /auth/jwt/token` endpoint takes no request payload — claims always derive from `CurrentPrincipal` alone.
- [03 — Lite verifier packaging](issues/03-lite-verifier-packaging.md) — a subpath export (`@effect-auth/jwt/verify`) with an import graph deliberately kept clear of `AuthPlugin`/`Sessions`/core, not a 21st package. Shares one internal claims/algorithm/JWKS-fetch module with the full plugin's own `verify`, rather than duplicating it. Has no access to the `sid` live-revocation check (ticket 05) — a documented limitation, not an open question.
- [04 — Claims, algorithm policy, config surface](issues/04-claims-algorithm-config-surface.md) — EdDSA default + ES256 alternative, no HS256; claims precedence (explicit payload wins, else plugin default) via a `definePayload`-equivalent config Effect plus a per-call override on the general-purpose primitive; `act`/`sid` populated unconditionally, mirroring `resolvePrincipal`'s existing pattern; 15-minute default TTL; `JwtConfig.issuer` is a required config value (no silent default, unlike `OAuthConfig.baseUrl`'s), `aud` defaults to `issuer`; `signJWT`/`verifyJWT` stay Effect-service-only, no HTTP surface, since no real caller needing one exists yet.
- [05 — Key rotation, persistence, remote signing](issues/05-key-rotation-persistence-remote-signing.md) — rotation is both time-based (90-day signing lifetime, 30-day grace, matching better-auth's own grace default) and explicitly CLI/admin-triggerable (`KeyRing.refresh`); `jwt_signing_key` schema carries `kid`/`alg`/`publicKeyJwk`/`privateKeyJwk`(`Redacted`-handled)/`createdAt`/`rotatedAt`/`retiresAt`; a remote signer signs raw bytes only, the plugin still assembles the JWS envelope; the `sid` live-check ships as a separately-named `verifyLive` function (requiring `Sessions` in its own `R`), never a flag on `verify`, and never on the lite verifier.

## Not yet specified

*(none — the frontier is now empty; every ticket above is resolved and written up in full in `.scratch/jwt/spec.md`)*

## Implementation

All 12 implementation tickets (`.scratch/jwt/issues/06` through `17`,
published via `/to-tickets` after this map's own frontier closed) are
`done`. `@effect-auth/jwt` is a fully working plugin: EdDSA/ES256 signing
against a `LayerRef`-backed, auto-rotating `KeyRing`; `GET /jwt/jwks` and
`GET /jwt/token`; `verify`/`verifyLive`/`signJWT`/`verifyJWT`; a standalone
`@effect-auth/jwt/verify` lite verifier with a genuinely independent import
graph; a remote-signing swap point; and automatic response mirroring via a
new, small, additive `PostAuthResponseHook` slot in
`packages/server/src/Authentication.ts` — the one real core touch this
effort made, kept deliberately proportionate. A delegated Spec-fidelity
code review (run against the full implementation, not part of any single
ticket) caught one real bug the implementation and its own tests missed —
`PostAuthResponseHook` firing on `OptionalAuthentication`'s anonymous
fallback, not just on a genuine successful resolution — fixed directly,
with a regression test added; see ticket 16's own `## Result` for the full
account. Full workspace verification (`pnpm typecheck`/`pnpm lint`/
`pnpm format:check`/`pnpm test`) is green: 67 files, 560 tests.

## Out of scope

- **`Bearer`** — already fully implemented in core (`packages/server/src/Authentication.ts`, BEH-EA-065–072); no plugin needed, no ticket, nothing to decide. Confirmed via ticket 00.
- **`sessionCookieCache: "jwt"` mode** — better-auth's own base-session rolling cookie-cache has no equivalent concept in effect-auth's architecture at all; there is no cache to attach a JWT signer to. Confirmed via ticket 00.
