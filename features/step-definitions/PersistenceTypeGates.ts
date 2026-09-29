// P20a/AH-003: compile-time half of 05-persistence-stratum.feature (BEH-EA-036). Same
// convention as `PluginTypeGates.ts`: compiled by the typecheck gate, tripwired by `assertTypeGate`.
import type { Models, Repositories } from "@awthaq/sql";
import type * as DateTime from "effect/DateTime";

// type-gate: keyset-only-no-offset
export const noOffsetParameter = (
  sessions: Repositories.SessionsRepositoryShape,
  user: Models.UserId,
  now: DateTime.Utc,
): void => {
  // @ts-expect-error - a sixth argument (an offset) is not accepted: the query takes at most five (BEH-EA-036)
  void sessions.listByUser(user, now, undefined, 10, undefined, 20);
  // @ts-expect-error - the options bag carries a read-consistency choice, never an offset
  void sessions.listByUser(user, now, undefined, 10, { offset: 20 });
};
