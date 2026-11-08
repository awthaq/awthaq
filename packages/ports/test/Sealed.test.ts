// Plan 17 (ADR-EA-019 decision 6): `Sealed`, the value an adapter hands to domain code unopened, and
// the sanctioned treatments of a value that does not open.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Sealed from "../src/Sealed.ts";

const unreadable = (reason: Sealed.Unreadable["reason"] = "DecryptionFailed") =>
  new Sealed.Unreadable({ table: "users", column: "metadata", rowKey: "u1", reason });

const broken: Sealed.Sealed<string> = { open: Effect.fail(unreadable()) };

const captureWarnings = () => {
  const logged: Array<{ readonly level: string; readonly annotations: string }> = [];
  const logger = Logger.make<unknown, void>((entry) => {
    logged.push({
      level: entry.logLevel,
      annotations: JSON.stringify(entry.fiber.getRef(References.CurrentLogAnnotations)),
    });
  });
  return { logged, layer: Logger.layer([logger]) };
};

describe("Sealed", () => {
  it.effect("plain always opens, to the value it was given", () =>
    Effect.gen(function* () {
      const opened = yield* Sealed.plain("hello").open;
      assert.strictEqual(Redacted.value(opened), "hello");
    }),
  );

  it.effect("openOption keeps None and opens a present value", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* Sealed.openOption(Option.none<Sealed.Sealed<string>>())));
      const opened = yield* Sealed.openOption(Option.some(Sealed.plain("v")));
      assert.deepStrictEqual(Option.map(opened, Redacted.value), Option.some("v"));
      const failure = yield* Sealed.openOption(Option.some(broken)).pipe(Effect.flip);
      assert.instanceOf(failure, Sealed.Unreadable);
    }),
  );

  it.effect(
    "optional: absent is None, readable is Some, unreadable is None with one ids-only warning",
    () => {
      const { logged, layer } = captureWarnings();
      return Effect.gen(function* () {
        assert.isTrue(Option.isNone(yield* Sealed.optional(Option.none<Sealed.Sealed<string>>())));
        const readable = yield* Sealed.optional(Option.some(Sealed.plain("secret-value")));
        assert.deepStrictEqual(Option.map(readable, Redacted.value), Option.some("secret-value"));
        assert.strictEqual(logged.length, 0);
        assert.isTrue(Option.isNone(yield* Sealed.optional(Option.some(broken))));
        assert.deepStrictEqual(
          logged.map((entry) => entry.level),
          ["Warn"],
        );
        assert.include(logged[0]?.annotations ?? "", '"table":"users"');
        assert.include(logged[0]?.annotations ?? "", '"rowKey":"u1"');
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "orDie turns Unreadable into a defect naming the column, and passes success through",
    () =>
      Effect.gen(function* () {
        const ok = yield* Sealed.orDie(Sealed.plain(1).open);
        assert.strictEqual(Redacted.value(ok), 1);
        const exit = yield* Effect.exit(Sealed.orDie(broken.open));
        assert.isTrue(exit._tag === "Failure");
        assert.include(String(exit), "users.metadata of u1");
        assert.notInclude(String(exit), "secret");
      }),
  );

  it.effect("option degrades an Unreadable to None and wraps a success in Some", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* Sealed.option(broken.open)));
      const ok = yield* Sealed.option(Sealed.plain("x").open);
      assert.deepStrictEqual(Option.map(ok, Redacted.value), Option.some("x"));
    }),
  );
});
