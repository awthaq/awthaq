// WORLD-01/WORLD-02 (D-09): the one `AuthEvents` subscriber a World reads its audit evidence back from.
//
// What it hides: the subscription timing and the append. `AuthEvents.stream` is a live broadcast, not a
// replay log, so a publish that beats the subscription is gone for good. The fork therefore starts
// immediately (`startImmediately`): without it the first request through the app could publish before
// the subscriber registered with the underlying `PubSub`. A real, reproduced bug (an empty
// `publishedEvents()` after a real impersonate call), fixed the same way in
// `packages/core/test/AuthEvents.test.ts`. An optional type predicate narrows what is kept, so a World
// whose Ref holds a narrower event type (AdminWorld) needs no cast.
//
// What it does not touch: `Auth.make`, `TestAuth.layer`, serve, lazyApp, the World tag, clocks. It is a
// layer that needs only `AuthEvents`, passed where the inline layer was (`taps` or `services`), so the
// plugin tuple and its missing-requirement compile error stay in the World (see EventCapture.types.ts).
//
// Four Worlds adopt it (Admin, Password, Domain, Organization). `OrganizationWorld` once registered through
// `authEvents.subscribe` with a plain fork; its steps tolerate this helper's `stream` + `startImmediately`
// timing (measured: the organization feature and the full suite stay green), so it moved here. Rebuilding the
// helper on `subscribe` with a plain fork instead failed five AdminWorld scenarios, whose steps read the Ref
// without polling.
import { AuthEvents } from "@awthaq/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

type Capture = Layer.Layer<never, never, AuthEvents.AuthEvents>;

export function captureEvents(into: Ref.Ref<ReadonlyArray<AuthEvents.PublishedAny>>): Capture;
export function captureEvents<E extends AuthEvents.PublishedAny>(
  into: Ref.Ref<ReadonlyArray<E>>,
  keep: (event: AuthEvents.PublishedAny) => event is E,
): Capture;
export function captureEvents<E extends AuthEvents.PublishedAny>(
  into: Ref.Ref<ReadonlyArray<E>>,
  keep: (event: AuthEvents.PublishedAny) => event is E = (_event): _event is E => true,
): Capture {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const authEvents = yield* AuthEvents.AuthEvents;
      yield* authEvents.stream.pipe(
        Stream.filter(keep),
        Stream.runForEach((event) => Ref.update(into, (existing) => [...existing, event])),
        Effect.forkScoped({ startImmediately: true }),
      );
    }),
  );
}
