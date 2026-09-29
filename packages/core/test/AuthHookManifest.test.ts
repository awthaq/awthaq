// PERS-003/JH-003, BEH-EA-096: a plugin declares its taps statically
// (`AuthPlugin.layer`'s `taps` option), so `Auth.make`'s manifest can print the
// resolved per-point order without building any layer — and that printed order
// is exactly the order the runtime chain executes in (one shared comparator).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as Auth from "../src/Auth.ts";
import * as AuthPlugin from "../src/AuthPlugin.ts";
import * as HookPoint from "../src/HookPoint.ts";

class Normalize extends HookPoint.veto<Normalize>()("auth.test.normalize", Schema.String) {}

const seen: Array<string> = [];
const trace = (name: string, transform: (value: string) => string) => (value: string) =>
  Effect.sync(() => {
    seen.push(name);
    return transform(value);
  });

const AlphaApi = HttpApi.make("auth").add(
  HttpApiGroup.make("alpha").add(
    HttpApiEndpoint.get("alpha", "/alpha", { success: Schema.String }),
  ),
);
const BetaApi = HttpApi.make("auth").add(
  HttpApiGroup.make("beta").add(HttpApiEndpoint.get("beta", "/beta", { success: Schema.String })),
);

class Alpha extends AuthPlugin.Service<Alpha, {}>()("alpha", {
  apiVersion: 1,
  contract: AlphaApi,
}) {
  static readonly layer = AuthPlugin.layer(Alpha, {
    make: Effect.succeed({}),
    taps: [
      Normalize.declareTap(
        trace("alpha", (value) => value.toLowerCase()),
        { order: 5 },
      ),
    ],
    handlers: HttpApiBuilder.group(AlphaApi, "alpha", (handlers) =>
      handlers.handle("alpha", () => Effect.succeed("alpha")),
    ),
  });
}

// `Beta` depends on `Alpha`, so its tap must run after Alpha's — even though its
// declared `order` is lower, and even when it is listed first in the tuple.
class Beta extends AuthPlugin.Service<Beta, {}>()("beta", {
  apiVersion: 1,
  contract: BetaApi,
}) {
  static readonly layer = AuthPlugin.layer(Beta, {
    dependsOn: [Alpha],
    make: Effect.succeed({}),
    taps: [
      Normalize.declareTap(
        trace("beta", (value) => `${value}!`),
        { order: 0 },
      ),
    ],
    handlers: HttpApiBuilder.group(BetaApi, "beta", (handlers) =>
      handlers.handle("beta", () => Effect.succeed("beta")),
    ),
  });
}

describe("Auth.make manifest.hooks (BEH-EA-096)", () => {
  it("lists every declared tap per point in resolved order, without building any layer", () => {
    const built = Auth.make([Alpha, Beta]);
    assert.deepStrictEqual(built.manifest.hooks, {
      "awthaq/hook/auth.test.normalize": [
        { plugin: "alpha", order: 5 },
        { plugin: "beta", order: 0 },
      ],
    });
    assert.deepStrictEqual(Beta.taps, [{ point: "awthaq/hook/auth.test.normalize", order: 0 }]);
  });

  it.effect(
    "the executed chain agrees with the manifest, and taps carry their plugin as owner",
    () =>
      Effect.gen(function* () {
        seen.length = 0;
        const point = yield* Normalize;
        const resolved = yield* point.resolved;
        assert.deepStrictEqual(resolved, [
          { owner: "alpha", order: 5 },
          { owner: "beta", order: 0 },
        ]);
        assert.strictEqual(yield* point.run("ABC"), "abc!");
        assert.deepStrictEqual(seen, ["alpha", "beta"]);
      }).pipe(
        // The plugins' layers require the hook point (a tap requires its point), so the
        // composed layer's RIn names it and the host provides it once.
        Effect.provide(Auth.make([Alpha, Beta]).layer.pipe(Layer.provideMerge(Normalize.layer))),
      ),
  );
});
