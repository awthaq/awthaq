// WORLD-01/WORLD-02, D-03: what `captureEvents` must not change about a World's composition. Typechecked
// (the `features` project of `tsc -b tsconfig.json` is the assertion; `tsconfig.test.json` does not include
// this file), never run. It carries no gate marker, so no scenario reads it.
//   1. a complete composition with the helper in `taps` is still closed;
//   2. leaving a required service out of a scaffolded World still does not serve (the missing-service gate
//      DomainWorld relies on: the breach `HttpClient`). Dropping a plugin from the `Auth.make` tuple is not a
//      compile error and never was.
import { Auth, AuthEvents } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { TestAuth } from "@awthaq/test";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { captureEvents } from "./EventCapture.ts";

const helper = captureEvents(Ref.makeUnsafe<ReadonlyArray<AuthEvents.PublishedAny>>([]));
const built = Auth.make([Password.Password]);

const closed = TestAuth.layer(built, {
  services: Layer.mergeAll(Password.config({}), TestAuth.httpClient.noBreach),
  taps: helper,
});
export const stillClosed: [Layer.Services<typeof closed>] extends [never] ? true : false = true;
/** Never called: serving the complete composition compiles (the positive control for the next claim). */
export const completeServes = () => TestAuth.serve(closed);

const withoutBreachClient = TestAuth.layer(built, { services: Password.config({}), taps: helper });
/** Never called: serving does not compile while the breach `HttpClient` is required and nothing provides it. */
export const missingServiceDoesNotServe = () =>
  // @ts-expect-error - the breach `HttpClient` is required by `Password` and left out of `services`
  // @effect-diagnostics-next-line missingLayerContext:off
  TestAuth.serve(withoutBreachClient);
