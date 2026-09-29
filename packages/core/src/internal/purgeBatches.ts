// CSG-003/ALF-010: retention deletes run as a loop of bounded statements, never one
// unbounded `DELETE` holding locks over a large backlog.

import * as Effect from "effect/Effect";

/** Rows deleted per statement. */
const PURGE_BATCH = 1000;

/** Runs `step` (which deletes at most `limit` rows and resolves to how many it deleted) until a batch comes back short, and resolves to the total. */
export const drainBatches = <E>(
  step: (limit: number) => Effect.Effect<number, E>,
  limit: number = PURGE_BATCH,
): Effect.Effect<number, E> =>
  Effect.gen(function* () {
    let total = 0;
    while (true) {
      const deleted = yield* step(limit);
      total += deleted;
      if (deleted < limit) return total;
    }
  });
