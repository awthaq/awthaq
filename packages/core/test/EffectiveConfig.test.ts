// ECS-008/EP-009 (BEH-EA-229, ADR-EA-006 rev 1.2): configuration descriptors are
// static (part of the manifest, no Layer evaluated), read back through a
// `Context`, and never unwrap a secret.
import { Tenant } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Auth from "../src/Auth.ts";
import * as AuthPlugin from "../src/AuthPlugin.ts";
import * as ConfigDescriptor from "../src/ConfigDescriptor.ts";
import * as EffectiveConfig from "../src/EffectiveConfig.ts";
import * as SessionCookie from "../src/SessionCookie.ts";

interface WidgetConfigShape {
  readonly minLength: number;
  readonly apiSecret: string;
  readonly signingKey: Redacted.Redacted<string>;
  readonly ttl: Duration.Duration;
  readonly nested: { readonly enabled: boolean };
}

const WidgetConfig = Context.Reference<WidgetConfigShape>("test/WidgetConfig", {
  defaultValue: () => ({
    minLength: 12,
    apiSecret: "sk-canary-default",
    signingKey: Redacted.make("canary-signing-key"),
    ttl: Duration.hours(1),
    nested: { enabled: true },
  }),
});

const WidgetScoped = Tenant.perTenant(WidgetConfig, { boot: ["apiSecret"] });

const widgetDescriptor = ConfigDescriptor.make(WidgetScoped, {
  sensitive: ["apiSecret"],
  audit: (value) =>
    value.minLength < 8
      ? [ConfigDescriptor.finding("warning", "widget-short", "minLength is below 8")]
      : [],
});

const WidgetApi = HttpApi.make("auth").add(
  HttpApiGroup.make("widget").add(
    HttpApiEndpoint.get("ping", "/widget", { success: Schema.String }),
  ),
);

class Widget extends AuthPlugin.Service<Widget, { readonly ok: true }>()("widget", {
  apiVersion: 1,
  contract: WidgetApi,
  config: [widgetDescriptor],
}) {
  static readonly layer = AuthPlugin.layer(Widget, {
    make: Effect.succeed<{ readonly ok: true }>({ ok: true }),
    handlers: HttpApiBuilder.group(WidgetApi, "widget", (handlers) =>
      handlers.handle("ping", () => Effect.succeed("pong")),
    ),
  });
}

const contextOf = (layer: Layer.Layer<never>) => Layer.build(layer).pipe(Effect.scoped);

describe("manifest.config", () => {
  it("lists a plugin's descriptor and its groups without building any Layer", () => {
    const auth = Auth.make([Widget]);
    assert.deepStrictEqual(
      auth.manifest.config.map((entry) => [entry.pluginId, entry.descriptor.key]),
      [["widget", "test/WidgetConfig"]],
    );
    assert.deepStrictEqual(auth.manifest.plugins[0]?.groups, ["widget"]);
  });
});

describe("EffectiveConfig", () => {
  const owned = EffectiveConfig.owned("widget", [widgetDescriptor]);

  it.effect("reports a default as source=default and renders secrets as <redacted>", () =>
    Effect.gen(function* () {
      const context = yield* contextOf(Layer.empty);
      const [item] = EffectiveConfig.read(context, owned);
      assert.strictEqual(item?.source, "default");
      const byPath = new Map(item?.entries.map((entry) => [entry.path, entry.value]));
      assert.strictEqual(byPath.get("minLength"), "12");
      assert.strictEqual(byPath.get("apiSecret"), "<redacted>");
      assert.strictEqual(byPath.get("signingKey"), "<redacted>");
      assert.strictEqual(byPath.get("nested.enabled"), "true");
      assert.ok(!JSON.stringify(item).includes("canary"));
    }),
  );

  it.effect("reports an overridden value as source=override and audits it", () =>
    Effect.gen(function* () {
      const context = yield* contextOf(
        Layer.succeed(WidgetConfig, {
          minLength: 4,
          apiSecret: "sk-canary-override",
          signingKey: Redacted.make("canary-2"),
          ttl: Duration.minutes(5),
          nested: { enabled: false },
        }),
      );
      const [item] = EffectiveConfig.read(context, owned);
      assert.strictEqual(item?.source, "override");
      assert.strictEqual(
        new Map(item?.entries.map((e) => [e.path, e.value])).get("minLength"),
        "4",
      );
      assert.ok(!JSON.stringify(item).includes("canary"));
      const found = EffectiveConfig.audit(context, owned, { production: true });
      assert.deepStrictEqual(
        found.map((f) => [f.owner, f.code]),
        [["widget", "widget-short"]],
      );
    }),
  );

  const widgetValue = (minLength: number, apiSecret: string): WidgetConfigShape => ({
    minLength,
    apiSecret,
    signingKey: Redacted.make("y"),
    ttl: Duration.hours(2),
    nested: { enabled: true },
  });

  it.effect(
    "snapshot reports a tenant-scoped key's calling value, boot fields from the build value (BEH-EA-355)",
    () =>
      Effect.gen(function* () {
        const built = yield* contextOf(
          Layer.succeed(WidgetConfig, widgetValue(20, "built-secret")),
        );
        const [item] = yield* EffectiveConfig.snapshot(built, owned).pipe(
          Effect.provideService(WidgetConfig, widgetValue(30, "tenant-secret")),
        );
        assert.strictEqual(item?.scope, "tenant");
        assert.strictEqual(item?.source, "tenant");
        const entries = new Map(item?.entries.map((e) => [e.path, e.value]));
        assert.strictEqual(entries.get("minLength"), "30");
        // `apiSecret` is a boot field and sensitive: redacted either way, and never the tenant's.
        assert.strictEqual(entries.get("apiSecret"), "<redacted>");
        assert.ok(!JSON.stringify(item).includes("tenant-secret"));
      }),
  );

  it.effect(
    "plan 36 F2: snapshot reports the value an operation reads, a build-only override included",
    () =>
      Effect.gen(function* () {
        const built = yield* contextOf(Layer.succeed(WidgetConfig, widgetValue(20, "x")));
        const [item] = yield* EffectiveConfig.snapshot(built, owned);
        assert.strictEqual(item?.source, "override");
        assert.strictEqual(
          new Map(item?.entries.map((e) => [e.path, e.value])).get("minLength"),
          "20",
        );
      }),
  );

  it.effect("a deployment-scoped key ignores a calling-fiber value (BEH-EA-355)", () =>
    Effect.gen(function* () {
      const Fixed = Context.Reference<{ readonly size: number }>("test/FixedConfig", {
        defaultValue: () => ({ size: 1 }),
      });
      const fixed = EffectiveConfig.owned("fixed", [
        ConfigDescriptor.make(Tenant.perDeployment(Fixed)),
      ]);
      const built = yield* contextOf(Layer.succeed(Fixed, { size: 2 }));
      const [item] = yield* EffectiveConfig.snapshot(built, fixed).pipe(
        Effect.provideService(Fixed, { size: 99 }),
      );
      assert.strictEqual(item?.scope, "deployment");
      assert.strictEqual(item?.source, "override");
      assert.strictEqual(new Map(item?.entries.map((e) => [e.path, e.value])).get("size"), "2");
    }),
  );

  it.effect(
    "scrubs the password out of a connection string even when the field is not declared sensitive",
    () =>
      Effect.gen(function* () {
        const Url = Context.Reference<{ readonly url: string }>("test/UrlConfig", {
          defaultValue: () => ({ url: "postgres://app:hunter2-canary@db.internal/app" }),
        });
        const context = yield* contextOf(Layer.empty);
        const [item] = EffectiveConfig.read(
          context,
          EffectiveConfig.owned("app", [ConfigDescriptor.make(Url)]),
        );
        assert.strictEqual(item?.entries[0]?.value, "postgres://app:<redacted>@db.internal/app");
      }),
  );

  it.effect("PV-016: the HostLax cookie mode is flagged like every relaxed SameSite", () =>
    Effect.gen(function* () {
      const context = yield* contextOf(SessionCookie.config({ mode: SessionCookie.HostLax }));
      const production = EffectiveConfig.audit(context, EffectiveConfig.core, { production: true });
      assert.deepStrictEqual(
        production.filter((f) => f.code === "cookie-samesite-relaxed").map((f) => f.severity),
        ["warning"],
      );
    }),
  );

  it.effect("the core session cookie descriptor flags a relaxed SameSite only in production", () =>
    Effect.gen(function* () {
      const context = yield* contextOf(
        SessionCookie.config({
          mode: SessionCookie.SecureDomain({ domain: "acme.com", sameSite: "lax" }),
        }),
      );
      const production = EffectiveConfig.audit(context, EffectiveConfig.core, { production: true });
      const development = EffectiveConfig.audit(context, EffectiveConfig.core, {
        production: false,
      });
      assert.deepStrictEqual(
        production.filter((f) => f.code === "cookie-samesite-relaxed").map((f) => f.severity),
        ["warning"],
      );
      assert.deepStrictEqual(
        development.filter((f) => f.code === "cookie-samesite-relaxed").map((f) => f.severity),
        ["info"],
      );
    }),
  );
});
