// BEH-EA-089 (REQ-EA-242/243) and BEH-EA-094 (REQ-EA-253/254): what a hook point's definition
// requires, and what tapping an undefined point costs, are compile-time facts. Nothing here
// executes — the assertions are the `@ts-expect-error` directives, checked by
// `tsc -p tsconfig.test.json`; the BDD scenarios that name them are `@skip` with this file as
// their rationale.
// @effect-diagnostics missingEffectContext:off
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HookPoint from "../src/HookPoint.ts";

describe("HookPoint definitions (BEH-EA-089)", () => {
  it("a point is defined by choosing one of the three kinds and giving it an input schema", () => {
    // Never called: these are compile-time claims, and the definitions below would not run.
    const definitions = () => {
      class Complete extends HookPoint.veto<Complete>()("auth.complete", Schema.String) {}
      // The kind is the factory: there is no generic `Service` that could omit it...
      // @ts-expect-error — `HookPoint.Service` does not exist; a kind is chosen by `veto`/`observe`/`divert`
      const noSuchFactory = HookPoint.Service;
      // ...and the input schema is a required argument of every factory.
      // @ts-expect-error — `input` is required
      class NoInput extends HookPoint.veto<NoInput>()("auth.no-input") {}
      return [Complete, noSuchFactory, NoInput];
    };
    void definitions;
  });
});

describe("tapping a point nobody defines (BEH-EA-094, INV-EA-005)", () => {
  class Invite extends HookPoint.veto<Invite>()("auth.invite.created", Schema.String) {}
  const tap = Invite.tap((value) => Effect.succeed(value));

  it("a tap on a point that is not in the composition keeps it in RIn, whether never defined or defined by a plugin since removed", () => {
    // Installed alone (no plugin providing the point — the state after the defining plugin is
    // removed from the tuple), the tap cannot be launched.
    const unsatisfied = () =>
      // @ts-expect-error — `Invite` is required but nothing provides it
      Effect.runPromise(Layer.launch(tap));
    const satisfied = () =>
      Effect.runPromise(Layer.launch(tap.pipe(Layer.provide(Invite.layer))));
    void unsatisfied;
    void satisfied;
  });
});
