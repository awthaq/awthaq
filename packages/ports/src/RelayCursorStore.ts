// @awthaq/ports — RelayCursorStore
//
// ADR-EA-030 decision 4, ADR-EA-041 (plan 23): where an event relay stopped. One position per relay
// `name`: the id of the last audit event its transport accepted. Every primitive is atomic and fails
// only with `StoreUnavailable` (ADR-EA-028). The bar for an adapter is `StoreContract.relayCursor`.
//
// `advance` only ever moves a position forward, in the byte order `AuditLogStore.pageAfter` replays
// in, so two relays that share a name (a worker in every replica) cannot pull each other back.
// The `Ref` adapter is single-process and test-grade (TRBS-005): a restarted relay begins again.

import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { StoreUnavailable } from "./Store.ts";

export interface RelayCursorStoreShape {
  /** The stored position of `name`; `None` before its first `advance`. Always authoritative. */
  readonly get: (name: string) => Effect.Effect<Option.Option<string>, StoreUnavailable>;
  /**
   * ATOMIC and MONOTONIC: stores `lastEventId` for `name` when there is no position yet or it is
   * after the stored one (byte order, `isAfter`); otherwise changes nothing. `at` is the caller's
   * clock reading. Idempotent, so an adapter may retry it.
   */
  readonly advance: (input: {
    readonly name: string;
    readonly lastEventId: string;
    readonly at: DateTime.Utc;
  }) => Effect.Effect<void, StoreUnavailable>;
}

export class RelayCursorStore extends Context.Service<RelayCursorStore, RelayCursorStoreShape>()(
  "awthaq/ports/RelayCursorStore",
) {}

/** The ordering every adapter uses: code units, which for the ASCII ids the audit log mints are bytes. */
export const isAfter = (candidate: string, stored: string) => candidate > stored;

/** In-process positions: lost on restart (a restarted relay begins again), for tests and single-process demos. */
export const layerMemory = Layer.effect(
  RelayCursorStore,
  Effect.gen(function* () {
    const positions = yield* Ref.make(HashMap.empty<string, string>());
    return RelayCursorStore.of({
      get: (name) => Effect.map(Ref.get(positions), (all) => HashMap.get(all, name)),
      advance: ({ name, lastEventId }) =>
        Ref.update(positions, (all) => {
          const stored = HashMap.get(all, name);
          return Option.isSome(stored) && !isAfter(lastEventId, stored.value)
            ? all
            : HashMap.set(all, name, lastEventId);
        }),
    });
  }),
);
