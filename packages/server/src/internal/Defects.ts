// @awthaq/server — internal defects
//
// GC-008: one tagged defect class for the invariants this package's
// handlers assume rather than check at the type level, replacing ad hoc
// `Effect.die(new Error(...))` — a plain `Error` carries no tag, so it cannot
// be told apart from any other defect by `Cause.dieOption` / a log filter.

import * as Data from "effect/Data";

export class HandlerInvariantViolation extends Data.TaggedError("HandlerInvariantViolation")<{
  /** Which assumed invariant did not hold. */
  readonly invariant: "NonUserPrincipal" | "AuthenticatedUserMissing";
  readonly message: string;
}> {}
