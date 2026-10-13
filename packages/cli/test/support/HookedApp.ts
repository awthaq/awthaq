// PV-241: two plugins that declare hook taps statically (`AuthPlugin.layer`'s `taps`), so
// `Auth.make(...).manifest.hooks` has something to print. `Beta` depends on `Alpha`, so its tap
// resolves after Alpha's even though its declared `order` is lower.
import { Auth, AuthPlugin, HookPoint } from "@awthaq/core";
import { Mailer, RateLimiter } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

/** ADR-EA-040: a domain service `Alpha` exposes beside its own service, so `--graph` has something to print. */
class Lamp extends Context.Service<Lamp, { readonly lit: boolean }>()("awthaq/plugin/alpha/Lamp") {}

const LampLive = Layer.succeed(Lamp, { lit: true });

class Normalize extends HookPoint.veto<Normalize>()("cli.test.normalize", Schema.String) {}

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
    // PV-241: declared, not used by `make` — the manifest only reads the declaration.
    ports: [Mailer.Mailer, RateLimiter.RateLimiter],
    exposes: { services: [Lamp], layer: LampLive },
    make: Effect.succeed({}),
    taps: [Normalize.declareTap((value) => Effect.succeed(value.toLowerCase()), { order: 5 })],
    handlers: HttpApiBuilder.group(AlphaApi, "alpha", (handlers) =>
      handlers.handle("alpha", () => Effect.succeed("alpha")),
    ),
  });
}

class Beta extends AuthPlugin.Service<Beta, {}>()("beta", {
  apiVersion: 1,
  contract: BetaApi,
}) {
  static readonly layer = AuthPlugin.layer(Beta, {
    dependsOn: [Alpha],
    make: Effect.succeed({}),
    taps: [Normalize.declareTap((value) => Effect.succeed(`${value}!`), { order: 0 })],
    handlers: HttpApiBuilder.group(BetaApi, "beta", (handlers) =>
      handlers.handle("beta", () => Effect.succeed("beta")),
    ),
  });
}

export const hookedApp = Auth.make([Alpha, Beta]);
