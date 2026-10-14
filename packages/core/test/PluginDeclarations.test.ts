// PV-241/BEH-EA-111/BEH-EA-202: a plugin declares its rate-limit rules (`Service`'s `rateLimits`) and the
// ports its layer requires (`AuthPlugin.layer`'s `ports`) statically, so the manifest — and `plugin list`
// — can print them without building a layer. The type-level halves (a rule's group confined to the
// plugin's own groups; a required port left undeclared refused) are `@ts-expect-error` directives,
// checked by `tsc -p tsconfig.test.json`.
import { RateLimiter } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as Auth from "../src/Auth.ts";
import * as AuthPlugin from "../src/AuthPlugin.ts";
import * as RateLimits from "../src/RateLimits.ts";

class Beacon extends Context.Service<Beacon, { readonly ping: Effect.Effect<void> }>()(
  "acme/ports/Beacon",
) {}

class Lantern extends Context.Service<Lantern, { readonly glow: Effect.Effect<void> }>()(
  "acme/ports/Lantern",
) {}

/** Not a port: a plugin's own records service is never declared. */
class Records extends Context.Service<Records, { readonly count: Effect.Effect<number> }>()(
  "acme/Records",
) {}

const SignalApi = HttpApi.make("auth")
  .add(
    HttpApiGroup.make("signal").add(
      HttpApiEndpoint.get("send", "/signal", { success: Schema.String }),
    ),
  )
  .add(
    HttpApiGroup.make("signal.verify").add(
      HttpApiEndpoint.post("verify", "/signal/verify", { success: Schema.String }),
    ),
  );

class Signal extends AuthPlugin.Service<Signal, {}>()("signal", {
  apiVersion: 1,
  contract: SignalApi,
  rateLimitRules: {
    sendByIp: RateLimits.rule({
      group: "signal",
      endpoint: "send",
      key: RateLimits.Key.ip,
      limit: 5,
      window: Duration.minutes(15),
    }),
    verifyByCode: RateLimits.rule({
      group: "signal.verify",
      endpoint: "verify",
      key: RateLimits.Key.identifier,
      limit: 3,
      window: Duration.minutes(1),
    }),
  },
}) {
  static readonly layer = AuthPlugin.layer(Signal, {
    ports: [Beacon, Lantern],
    make: Effect.gen(function* () {
      yield* Beacon;
      yield* Lantern;
      yield* Records;
      return {};
    }),
    handlers: Layer.mergeAll(
      HttpApiBuilder.group(SignalApi, "signal", (handlers) =>
        handlers.handle("send", () => Effect.succeed("sent")),
      ),
      HttpApiBuilder.group(SignalApi, "signal.verify", (handlers) =>
        handlers.handle("verify", () => Effect.succeed("verified")),
      ),
    ),
  });
}

describe("rateLimits declaration (PV-241)", () => {
  it("is a readonly static, empty by default, and reaches the manifest in link order", () => {
    class Quiet extends AuthPlugin.Service<Quiet, {}>()("quiet", {
      apiVersion: 1,
      contract: HttpApi.make("auth"),
    }) {}
    assert.deepStrictEqual(Quiet.rateLimits, []);
    assert.strictEqual(Signal.rateLimits.length, 2);
    const manifest = Auth.make([Signal]).manifest;
    assert.deepStrictEqual(
      manifest.rateLimits.map((rule) => [rule.plugin, rule.group, rule.endpoint, rule.name]),
      [
        ["signal", "signal", "send", "sendByIp"],
        ["signal", "signal.verify", "verify", "verifyByCode"],
      ],
    );
  });

  it("refuses, at compile time, a group that is not one of the plugin's own", () => {
    class Stray extends AuthPlugin.Service<Stray, {}>()("stray", {
      apiVersion: 1,
      contract: HttpApi.make("auth").add(
        HttpApiGroup.make("stray").add(
          HttpApiEndpoint.get("send", "/stray", { success: Schema.String }),
        ),
      ),
      rateLimitRules: {
        // @ts-expect-error — "elsewhere" is not a group of this contract
        sendByIp: RateLimits.rule({
          group: "elsewhere",
          endpoint: "send",
          key: RateLimits.Key.ip,
          limit: 1,
          window: Duration.seconds(1),
        }),
      },
    }) {}
    assert.strictEqual(Stray.rateLimits.length, 1);
  });

  it("rateLimitRules derive the static declaration, with the key strategy and the mode", () => {
    class Table extends AuthPlugin.Service<Table, {}>()("table", {
      apiVersion: 1,
      contract: HttpApi.make("auth").add(
        HttpApiGroup.make("table").add(
          HttpApiEndpoint.get("send", "/table", { success: Schema.String }),
        ),
      ),
      rateLimitRules: {
        sendByIp: RateLimits.rule({
          group: "table",
          endpoint: "send",
          key: RateLimits.Key.ip,
          limit: 5,
          window: Duration.minutes(15),
        }),
        lockout: RateLimits.failureRule({
          group: "table",
          endpoint: "send",
          key: RateLimits.Key.user,
          limit: 3,
          window: Duration.minutes(1),
          bucket: "table.lockout",
        }),
      },
    }) {
      static readonly layer = AuthPlugin.layer(Table, {
        ports: [RateLimiter.RateLimiter],
        make: Effect.gen(function* () {
          yield* RateLimits.budget(Table);
          return {};
        }),
      });
    }
    assert.deepStrictEqual(
      Auth.make([Table]).manifest.rateLimits.map((rule) => [
        rule.plugin,
        rule.name,
        rule.dimension,
        rule.key,
        rule.mode,
        rule.limit,
      ]),
      [
        ["table", "sendByIp", "ip", "ip", "attempts", 5],
        ["table", "lockout", "principal", "user", "failures", 3],
      ],
    );
  });
});

describe("ports declaration (PV-241/BEH-EA-202)", () => {
  it("is a readonly static of keys, and reaches the manifest without building the layer", () => {
    assert.deepStrictEqual(Signal.ports, ["acme/ports/Beacon", "acme/ports/Lantern"]);
    assert.deepStrictEqual(Auth.make([Signal]).manifest.ports, [
      { plugin: "signal", key: "acme/ports/Beacon" },
      { plugin: "signal", key: "acme/ports/Lantern" },
    ]);
  });

  it("joins the layer's requirements like dependsOn", () => {
    type Needs = Layer.Services<typeof Signal.layer>;
    const needsBoth: [Beacon | Lantern] extends [Needs] ? true : false = true;
    void needsBoth;
  });

  it("refuses, at compile time, a required port that is not declared", () => {
    class Forgetful extends AuthPlugin.Service<Forgetful, {}>()("forgetful", {
      apiVersion: 1,
      contract: HttpApi.make("auth"),
    }) {
      static readonly layer = AuthPlugin.layer(Forgetful, {
        // @ts-expect-error — `Lantern` is required by `make` but not in `ports`
        ports: [Beacon],
        make: Effect.gen(function* () {
          yield* Beacon;
          yield* Lantern;
          return {};
        }),
      });
    }
    assert.deepStrictEqual(Forgetful.ports, ["acme/ports/Beacon"]);
  });

  it("does not ask for a non-port service, and a plugin with no port needs no declaration", () => {
    class Plain extends AuthPlugin.Service<Plain, {}>()("plain", {
      apiVersion: 1,
      contract: HttpApi.make("auth"),
    }) {
      static readonly layer = AuthPlugin.layer(Plain, {
        make: Effect.gen(function* () {
          yield* Records;
          return {};
        }),
      });
    }
    assert.deepStrictEqual(Plain.ports, []);
  });
});
