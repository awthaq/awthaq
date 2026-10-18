// P20a/AH-003: compile-time half of 05-persistence-stratum.feature (BEH-EA-036). Same
// convention as `PluginTypeGates.ts`: compiled by the typecheck gate, tripwired by `assertTypeGate`.
import type { UserStore } from "@awthaq/ports";
import * as Option from "effect/Option";

// type-gate: keyset-only-no-offset
export const noOffsetParameter = (users: UserStore.UserStoreShape): void => {
  // @ts-expect-error - an offset is not accepted: the page takes an opaque cursor and a limit only (BEH-EA-036)
  void users.listPage({ after: Option.none(), limit: 10, offset: 20 });
};
