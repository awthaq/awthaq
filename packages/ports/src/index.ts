// @effect-auth/ports — Ports stratum (2)
//
// PasswordHasher, Mailer, WebAuthn — each with layer, layerNoop, layerMemory variants. A plugin depends on a port, never a concrete implementation (capability over implementation).
//
// `PasswordHasher` and `Mailer` are implemented below; see each module's own
// header comment for its grounding (no BEH-EA range is allocated for the
// Ports stratum yet — spec/traceability.md — so both cite spec/overview.md
// and archive/design directly).
//
// `WebAuthn` is deliberately not yet implemented: unlike `PasswordHasher`
// (given a concrete interface in `archive/design/api-design-v4.md` §3),
// nothing in `spec/` or `archive/` names WebAuthn's own port methods —
// `spec/models/03-passkey-webauthn.md` states its whole passkey plugin
// sketch, port included, is "speculative — it is not quoted from
// `archive/PRD.md`". Designing this port's shape is better done alongside
// the `@effect-auth/passkey` plugin that will be its only consumer, where
// the plugin's actual ceremony calls (registration/authentication options,
// response verification, challenge storage — see `research/06-webauthn-passkeys.md`)
// will settle what the port actually needs to expose, rather than guessed
// at now with no caller to validate the guess against.
//
// `RateLimiter` (spec/behaviors/14-rate-limiting.md, BEH-EA-105/106/109/112)
// is implemented below too — see that module's own header comment for why
// it lives here rather than in `@effect-auth/core`.
//
// See spec/overview.md for the full package map.

export * as Mailer from "./Mailer.ts";
export * as PasswordHasher from "./PasswordHasher.ts";
export * as RateLimiter from "./RateLimiter.ts";
