// @effect-auth/core — Migrations
//
// A minimal placeholder ahead of the Persistence stratum (BEH-EA-033 through
// BEH-EA-040, spec/behaviors/05-persistence-stratum.md), which owns the real,
// SqlClient-shaped migration signature. `AuthPlugin` and `Auth.make` only need
// a name to re-key (BEH-EA-016) and something runnable — that is fixed here so
// the plugin contract does not have to wait on the persistence stratum to
// exist.

import type * as Effect from "effect/Effect";

export interface Migration {
  readonly name: string;
  readonly up: Effect.Effect<void, unknown, unknown>;
  readonly down?: Effect.Effect<void, unknown, unknown>;
}

export type Migrations = ReadonlyArray<Migration>;
