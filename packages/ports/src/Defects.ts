// @awthaq/ports — Defects
//
// GC-008 / MA-004 follow-up. A defect (`Effect.die`) is for what no caller can recover from: a
// deployment that is misconfigured, a database dialect nothing here speaks, or an invariant this
// code itself broke. It used to be `Effect.die(new Error("awthaq: ..."))` at about a hundred call
// sites, and a plain `Error` carries no tag: a log pipeline, an alert or a test could not tell "the
// operator set keyGracePeriod too low" from "a row vanished between check and write" except by
// string-matching prose. These three tagged classes name the three kinds; the message stays a
// constant sentence, and the specifics ride in typed fields (never an identifier a credential
// could hide in, EOTS-004).
//
// Infrastructure failures are not defects — they are `StoreUnavailable` (ADR-EA-028) — and neither
// is anything a request can cause, which is a typed error in the operation's `E`.

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** The composition is wrong (a setting out of range, a provider without an issuer): found at build time, never per request. */
export class InvalidConfiguration extends Data.TaggedError("Defects/InvalidConfiguration")<{
  readonly setting: string;
  readonly message: string;
}> {}

/** A SQL dialect no migration or query here has a branch for. */
export class UnsupportedDialect extends Data.TaggedError("Defects/UnsupportedDialect")<{
  readonly operation: string;
  readonly message: string;
}> {}

/** A condition this code guarantees no caller can cause (a row that vanished between a check and the write that follows it, a non-user principal behind a user-only group). */
export class InvariantViolation extends Data.TaggedError("Defects/InvariantViolation")<{
  readonly invariant: string;
  readonly message: string;
}> {}

/** `Effect.die` with an `InvalidConfiguration`; `setting` names what to fix, `message` says why (already `awthaq...`-prefixed by the caller). */
export const invalidConfiguration = (setting: string, message: string) =>
  Effect.die(new InvalidConfiguration({ setting, message }));

/** `Effect.die` with an `UnsupportedDialect` for `operation` (`"migrations"`, `"models"`, ...). */
export const unsupportedDialect = (operation: string) =>
  Effect.die(
    new UnsupportedDialect({
      operation,
      message: `awthaq: unsupported SQL dialect for ${operation}`,
    }),
  );

/** `Effect.die` with an `InvariantViolation`; `invariant` is the stable name, `message` the explanation (already prefixed). */
export const invariantViolation = (invariant: string, message: string) =>
  Effect.die(new InvariantViolation({ invariant, message }));
