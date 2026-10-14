// Plan 01 phase 6: `AuthHttp.coreHandlers` logs one build-time warning when `RequestContext.layer` was not merged on
// its router, because every session minted over HTTP would then record no address or user agent (E1). Tested both ways,
// plus the silencing switch the in-process test harness uses.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as AuthHttp from "../src/AuthHttp.ts";
import * as RequestContext from "../src/RequestContext.ts";

/** Builds the check beside `extra` on one router and returns the warnings it logged. */
const warningsFor = (extra: Layer.Layer<never, never, HttpRouter.HttpRouter | Crypto.Crypto>) =>
  Effect.gen(function* () {
    const messages: Array<string> = [];
    const capture = Logger.make<unknown, void>((options) => {
      if (options.logLevel === "Warn") messages.push(String(options.message));
    });
    yield* Layer.build(
      Layer.mergeAll(AuthHttp.requestContextCheck, extra).pipe(
        Layer.provide(HttpRouter.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Logger.layer([capture])),
      ),
    );
    return messages;
  });

describe("AuthHttp.coreHandlers' RequestContext check", () => {
  it.effect("warns once at build time when RequestContext.layer is absent", () =>
    Effect.gen(function* () {
      const messages = yield* warningsFor(Layer.empty);
      assert.strictEqual(messages.length, 1);
      assert.include(messages[0] ?? "", "RequestContext.layer is not installed");
    }),
  );

  it.effect("is silent when RequestContext.layer is merged on the same router", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* warningsFor(RequestContext.layer), []);
    }),
  );

  it.effect("is silent when the composition provides warnWhenAbsent as false", () =>
    Effect.gen(function* () {
      const messages: Array<string> = [];
      const capture = Logger.make<unknown, void>((options) => {
        if (options.logLevel === "Warn") messages.push(String(options.message));
      });
      yield* Layer.build(
        AuthHttp.requestContextCheck.pipe(
          Layer.provide(Layer.succeed(RequestContext.warnWhenAbsent, false)),
          Layer.provide(HttpRouter.layer),
          Layer.provide(Logger.layer([capture])),
        ),
      );
      assert.deepStrictEqual(messages, []);
    }),
  );
});
