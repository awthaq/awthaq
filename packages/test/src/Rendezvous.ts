// @awthaq/test — Rendezvous
//
// A two-party (or n-party) meeting point for tests that force an interleaving. Plan 14: two federated sign-ins for
// one new identity must both read the account anchor before either writes, so the loser of the race is exercised
// deterministically instead of by luck. `anchorReadsMeet(2)` wraps `Accounts` so that the first two anchor reads
// finish only once both have happened; no write can slip between them.

import { Accounts } from "@awthaq/core";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/** A one-shot meeting point: the first `parties - 1` arrivals wait for the last; later arrivals pass straight through. */
export const make = (parties: number) =>
  Effect.gen(function* () {
    const arrived = yield* Ref.make(0);
    const open = yield* Deferred.make<void>();
    const arrive = Effect.flatMap(
      Ref.updateAndGet(arrived, (n) => n + 1),
      (n) =>
        n >= parties ? Effect.asVoid(Deferred.succeed(open, undefined)) : Deferred.await(open),
    );
    return { arrive };
  });

/** `Accounts` whose anchor read meets `parties` callers before any of them goes on. */
export const anchorReadsMeet = (parties: number) =>
  Layer.effect(
    Accounts.Accounts,
    Effect.gen(function* () {
      const inner = yield* Accounts.Accounts;
      const meeting = yield* make(parties);
      return Accounts.Accounts.of({
        ...inner,
        findByProviderSubject: (providerId, subject, issuer) =>
          Effect.tap(
            inner.findByProviderSubject(providerId, subject, issuer),
            () => meeting.arrive,
          ),
      });
    }),
  );
