// @awthaq/ports — LegacySessionBridge
//
// BAM-003 (.issues/high): an optional, additive fallback `Sessions.verify`
// consults only on a primary-store miss (a malformed token, or an id it
// doesn't recognize) — the exact shape a "still-live better-auth session"
// takes once effect-auth's own `id.secret` parsing rejects it outright.
// Defaults to a true no-op (`resolve` always `None`), mirroring
// `@awthaq/server`'s own `Authentication.ts` `PostAuthResponseHook`
// `Context.Reference` pattern — installing nothing changes nothing about
// existing behavior, and forced re-login remains the literal default a
// deployment gets by simply not installing a bridge implementation.
//
// `userId` is a bare `string`, not `@awthaq/core`'s branded `Users.UserId`:
// Ports sits below Domain in the stratum ordering
// (spec/decisions/001-plugins-contribute-layers.md's own list), so Ports
// may not depend on Core. `Sessions.ts` (Domain, already depends on Ports)
// does the branding itself after consulting this reference — the same
// division `PasswordHasher.ts`'s own `LegacyPasswordVerifiers` establishes
// for AOMS-001's structurally identical problem one port over.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export interface LegacySessionBridgeShape {
  /**
   * `rawToken` is the full, unparsed credential `Sessions.verify` was
   * handed — a still-live legacy session's own opaque token, never
   * effect-auth's own `id.secret` shape (which always parses on its own
   * and never reaches this reference). `None` means "not a bridgeable
   * legacy session" — including "not installed," "expired upstream," and
   * "already consumed" — never distinguished from each other externally,
   * matching `Sessions.verify`'s own uniform `SessionNotFound` posture.
   */
  readonly resolve: (rawToken: string) => Effect.Effect<
    Option.Option<{
      readonly userId: string;
      readonly ipAddress: Option.Option<string>;
      readonly userAgent: Option.Option<string>;
    }>
  >;
  /**
   * Called once, only after a `resolve` hit has been used to mint a fresh
   * awthaq session — makes the legacy credential single-use so it cannot
   * be replayed to mint a second session, mirroring RRS-003's own
   * single-use-then-tombstoned posture for a rotated-away row.
   */
  readonly consume: (rawToken: string) => Effect.Effect<void>;
}

export const LegacySessionBridge = Context.Reference<LegacySessionBridgeShape>(
  "awthaq/ports/LegacySessionBridge",
  {
    defaultValue: () => ({
      resolve: () => Effect.succeedNone,
      consume: () => Effect.void,
    }),
  },
);
