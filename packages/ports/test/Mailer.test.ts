// See src/Mailer.ts's own header comment for what this port is grounded in
// (no BEH-EA range is allocated for the Ports stratum yet).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Mailer from "../src/Mailer.ts";

describe("Mailer.layerMemory", () => {
  it.effect("records every sent message, in order", () =>
    Effect.gen(function* () {
      const mailer = yield* Mailer.Mailer;
      yield* mailer.send({ to: "a@example.com", template: "welcome" });
      yield* mailer.send({ to: "b@example.com", template: "reset", data: { token: "abc" } });
      const sent = yield* mailer.sent;
      assert.deepStrictEqual(sent, [
        { to: "a@example.com", template: "welcome" },
        { to: "b@example.com", template: "reset", data: { token: "abc" } },
      ]);
    }).pipe(Effect.provide(Mailer.layerMemory)),
  );

  it.effect("starts empty", () =>
    Effect.gen(function* () {
      const mailer = yield* Mailer.Mailer;
      assert.deepStrictEqual(yield* mailer.sent, []);
    }).pipe(Effect.provide(Mailer.layerMemory)),
  );
});

describe("Mailer.layerNoop", () => {
  it.effect("dies loudly instead of silently dropping mail", () =>
    Effect.gen(function* () {
      const mailer = yield* Mailer.Mailer;
      const exit = yield* Effect.exit(mailer.send({ to: "a@example.com", template: "welcome" }));
      assert.isTrue(exit._tag === "Failure");
    }).pipe(Effect.provide(Mailer.layerNoop)),
  );

  it.effect("sent is always empty", () =>
    Effect.gen(function* () {
      const mailer = yield* Mailer.Mailer;
      assert.deepStrictEqual(yield* mailer.sent, []);
    }).pipe(Effect.provide(Mailer.layerNoop)),
  );
});
