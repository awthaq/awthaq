// WORLD-01/WORLD-02, D-03: what `captureEvents` must not change about a World's composition. Typechecked
// (`tsc -p tsconfig.test.json` is the assertion), never run. It carries no gate marker, so no scenario reads it.
//   1. the helper needs exactly `AuthEvents`, no plugin service;
//   2. a complete composition with the helper in `taps` is still closed;
//   3. an incomplete one (a foreign tap beside the helper) still does not launch.
import { Auth, AuthEvents, HookPoint } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { TestAuth } from "@awthaq/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { captureEvents } from "./EventCapture.ts";

const helper = captureEvents(Ref.makeUnsafe<ReadonlyArray<AuthEvents.PublishedAny>>([]));

export const needsOnlyAuthEvents: [Layer.Services<typeof helper>] extends [AuthEvents.AuthEvents]
  ? [AuthEvents.AuthEvents] extends [Layer.Services<typeof helper>]
    ? true
    : false
  : false = true;

const built = Auth.make([Password.Password]);
const services = Layer.mergeAll(Password.config({}), TestAuth.httpClient.noBreach);

const closed = TestAuth.layer(built, { services, taps: helper });
export const stillClosed: [Layer.Services<typeof closed>] extends [never] ? true : false = true;

class Undeclared extends HookPoint.observe<Undeclared>()(
  "types.eventCapture.undeclared.after",
  Schema.Struct({}),
) {}
const withForeignTap = TestAuth.layer(built, {
  services,
  taps: Layer.mergeAll(
    helper,
    Undeclared.tap(() => Effect.void),
  ),
});
/** Never called: launching it does not compile while the point is unprovided (claim 2 is the positive control). */
export const foreignTapDoesNotLaunch = () =>
  // @ts-expect-error - `Undeclared` is required by the tap and nothing in the composition provides it
  Effect.runPromise(Layer.launch(withForeignTap));
