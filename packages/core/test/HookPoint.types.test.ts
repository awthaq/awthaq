// BEH-EA-094/INV-EA-005: tapping a hook point nobody provides is a compile
// error. A tap's Layer requires its point (ELC-001), so launching it without
// the point's layer leaves that point in the composition's `RIn` and the
// program cannot be run. Nothing here executes — the assertions are the
// `@ts-expect-error` directives, checked by `tsc -p tsconfig.test.json`.
// @effect-diagnostics missingEffectContext:off
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HookPoint from "../src/HookPoint.ts";

class BeforeThing extends HookPoint.veto<BeforeThing>()("auth.thing", Schema.String) {}
const tap = BeforeThing.tap((value) => Effect.succeed(value));

describe("HookPoint types (INV-EA-005)", () => {
  it("a tap without its point's layer keeps the point in RIn", () => {
    const unsatisfied = () =>
      // @ts-expect-error — `BeforeThing` is required but nothing provides it
      Effect.runPromise(Layer.launch(tap));
    const satisfied = () => Effect.runPromise(Layer.launch(tap.pipe(Layer.provide(BeforeThing.layer))));
    void unsatisfied;
    void satisfied;
  });
});
