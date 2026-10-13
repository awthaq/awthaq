// Plan 08 (BEH-EA-T4/T5): `AuthPlugin.Service` exposes the `records` bundle and `hookPoints` a plugin
// declares (empty layers when it declares none), and `Auth.make(...).plugins` is the tuple it was given.
// The compile-time half is `AuthPlugin.records.types.test.ts`.
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as Auth from "../src/Auth.ts";
import * as AuthPlugin from "../src/AuthPlugin.ts";
import * as HookPoint from "../src/HookPoint.ts";

class PinRecords extends Context.Service<PinRecords, { readonly count: number }>()(
  "pins/records/PinRecords",
) {}
class BeforePin extends HookPoint.veto<BeforePin>()("pins.before", Schema.String) {}

const memory = Layer.succeed(PinRecords, { count: 1 });
const sql = Layer.succeed(PinRecords, { count: 2 });

class Bare extends AuthPlugin.Service<Bare, {}>()("bare", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
}) {
  static readonly layer = AuthPlugin.layer(Bare, { make: Effect.succeed({}) });
}

class Pins extends AuthPlugin.Service<Pins, {}>()("pins", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
  records: { memory, sql },
  hookPoints: BeforePin.layer,
}) {
  static readonly layer = AuthPlugin.layer(Pins, {
    make: Effect.gen(function* () {
      yield* PinRecords;
      yield* BeforePin;
      return {};
    }),
  });
}

describe("AuthPlugin records and hookPoints (plan 08)", () => {
  it("a plugin that declares neither reads Layer.empty for both modes and for its points", () => {
    assert.strictEqual(Bare.records.memory, Layer.empty);
    assert.strictEqual(Bare.records.sql, Layer.empty);
    assert.strictEqual(Bare.hookPoints, Layer.empty);
  });

  it("a plugin that declares them exposes exactly what it declared", () => {
    assert.strictEqual(Pins.records.memory, memory);
    assert.strictEqual(Pins.records.sql, sql);
    assert.strictEqual(Pins.hookPoints, BeforePin.layer);
  });

  it.effect("the declared bundle and points are what build the plugin's layer", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Pins.layer.pipe(Layer.provideMerge(Layer.merge(Pins.records.memory, Pins.hookPoints))),
      );
      assert.strictEqual(Context.get(context, PinRecords).count, 1);
    }).pipe(Effect.scoped),
  );

  it("Auth.make keeps the plugin tuple as given", () => {
    const given = [Bare, Pins] as const;
    const built = Auth.make(given);
    assert.strictEqual(built.plugins, given);
    assert.strictEqual(built.plugins[1].records.memory, memory);
  });
});
