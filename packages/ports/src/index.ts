// @effect-auth/ports — Ports stratum (2)
//
// PasswordHasher, Mailer, WebAuthn — each with layer, layerNoop, layerMemory variants. A plugin depends on a port, never a concrete implementation (capability over implementation).
//
// `PasswordHasher` and `Mailer` are implemented below; see each module's own
// header comment for its grounding (no BEH-EA range is allocated for the
// Ports stratum yet — spec/traceability.md — so both cite spec/overview.md
// and archive/design directly).
//
// `WebAuthn` (spec/behaviors/17-passkey.md, BEH-EA-129) is implemented too,
// wrapping `@simplewebauthn/server` — see that module's own header comment.
// A prior revision of this comment claimed WebAuthn's port was "deliberately
// not yet implemented" because "nothing in spec/ or archive/ names WebAuthn's
// own port methods"; that was already stale by the time it was corrected —
// `spec/behaviors/17-passkey.md`'s BEH-EA-129 names the exact four-method
// interface this module implements.
//
// `RateLimiter` (spec/behaviors/14-rate-limiting.md, BEH-EA-105/106/109/112)
// is implemented below too — see that module's own header comment for why
// it lives here rather than in `@effect-auth/core`.
//
// See spec/overview.md for the full package map.

export * as Mailer from "./Mailer.ts";
export * as PasswordHasher from "./PasswordHasher.ts";
export * as RateLimiter from "./RateLimiter.ts";
export * as WebAuthn from "./WebAuthn.ts";
