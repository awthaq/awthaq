// BEH-EA-T2/T4/T5 at the harness boundary: `TestAuth.layer`'s `RIn` is `never` exactly when the composition is
// complete, in both record modes; `records: "sql"` without a `suite` is a compile error. (The bundle and hook
// point completeness errors are `AuthPlugin.records.types.test.ts`, in core.) Compile-time checks
// (`tsc -p tsconfig.test.json` is the assertion) with a token runtime test so the file is a suite.
import { Auth, HookPoint } from "@awthaq/core";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestAuth from "../src/TestAuth.ts";
import { Pins } from "./support/Pins.ts";

const built = Auth.make([Pins]);

// A complete composition needs nothing: the harness provides the records bundle, the middleware, the ports.
export const memoryIsClosed: Layer.Layer<unknown, unknown, never> = TestAuth.layer(built);
export const sqlIsClosed: Layer.Layer<unknown, unknown, never> = TestAuth.layer(built, {
  records: "sql",
  suite: "types",
});

// SQL mode needs a suite name (it names the Postgres schema).
// @ts-expect-error - `records: "sql"` without `suite`
export const sqlNeedsASuite = TestAuth.layer(built, { records: "sql" });

// Plan 15 (INV-EA-005 through the harness): a tap on a point no composed plugin declares stays in `RIn`.
class Undeclared extends HookPoint.observe<Undeclared>()(
  "types.undeclared.after",
  Schema.Struct({}),
) {}
const tapped = TestAuth.layer(built, { taps: Undeclared.tap(() => Effect.void) });
export const foreignTapStaysRequired: Layer.Services<typeof tapped> extends Undeclared
  ? [Undeclared] extends [Layer.Services<typeof tapped>]
    ? true
    : false
  : false = true;
/** Never called: launching it does not compile while the point is unprovided. */
export const foreignTapDoesNotLaunch = () =>
  // @ts-expect-error - `Undeclared` is required by the tap and nothing in the composition provides it
  // @effect-diagnostics-next-line missingEffectContext:off
  Effect.runPromise(Layer.launch(tapped));

it("the guarantees above are checked by the compiler", () => {});
