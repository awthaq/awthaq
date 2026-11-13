// BEH-EA-355 (ADR-EA-018 decision 8): a key's scope is declared once; `resolveConfig` is the one rule and `inForce` the
// one accessor. Tenant-scoped: the calling fiber's value, boot fields from the build value. Deployment-scoped: the
// build value, always.
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tenant from "../src/Tenant.ts";

interface KnobsShape {
  readonly limit: number;
  readonly key: string;
}

const Knobs = Context.Reference<KnobsShape>("test/TenantConfigScope/Knobs", {
  defaultValue: () => ({ limit: 1, key: "default" }),
});

class Provider extends Context.Service<Provider, KnobsShape>()("test/TenantConfigScope/Provider") {}

const built: KnobsShape = { limit: 5, key: "built" };
const tenantValue: KnobsShape = { limit: 9, key: "tenant" };
const callingWith = (value: KnobsShape) => Context.make(Knobs, value);

const perTenant = Tenant.perTenant(Knobs, { boot: ["key"] });
const perDeployment = Tenant.perDeployment(Knobs);

describe("Tenant.resolveConfig and Tenant.inForce (BEH-EA-355)", () => {
  it("a tenant-scoped key reads the calling value, with boot fields from the build value", () => {
    assert.deepStrictEqual(Tenant.resolveConfig(perTenant, built, callingWith(tenantValue)), {
      limit: 9,
      key: "built",
    });
  });

  it("with no calling value the build value applies, in both scopes", () => {
    assert.deepStrictEqual(Tenant.resolveConfig(perTenant, built, Context.empty()), built);
    assert.deepStrictEqual(Tenant.resolveConfig(perDeployment, built, Context.empty()), built);
  });

  it("a deployment-scoped key ignores a calling value", () => {
    assert.deepStrictEqual(
      Tenant.resolveConfig(perDeployment, built, callingWith(tenantValue)),
      built,
    );
  });

  it.effect("inForce, yielded once at build, resolves per fiber", () =>
    Effect.gen(function* () {
      const now = yield* Tenant.inForce(perTenant);
      const first = yield* Effect.provideService(now, Knobs, tenantValue);
      const second = yield* Effect.provideService(now, Knobs, { limit: 2, key: "other" });
      const none = yield* now;
      assert.deepStrictEqual(first, { limit: 9, key: "default" });
      assert.deepStrictEqual(second, { limit: 2, key: "default" });
      assert.deepStrictEqual(none, { limit: 1, key: "default" });
    }),
  );

  it.effect("inForce equals resolveConfig in the same fiber, for both scopes", () =>
    Effect.gen(function* () {
      const calling = Context.make(Knobs, tenantValue);
      for (const declared of [perTenant, perDeployment]) {
        const now = yield* Tenant.inForce(declared).pipe(Effect.provideService(Knobs, built));
        const seen = yield* now.pipe(Effect.provideService(Knobs, tenantValue));
        assert.deepStrictEqual(seen, Tenant.resolveConfig(declared, built, calling));
      }
    }),
  );

  it.effect("a Context.Service key works, and inForce requires it", () =>
    Effect.gen(function* () {
      const declared = Tenant.perTenant(Provider);
      const now = yield* Tenant.inForce(declared);
      assert.deepStrictEqual(yield* now, built);
      assert.deepStrictEqual(
        yield* now.pipe(Effect.provideService(Provider, tenantValue)),
        tenantValue,
      );
    }).pipe(Effect.provide(Layer.succeed(Provider, built))),
  );

  it.effect(
    "layers: a deployment-scoped one also provides the marker, a tenant-scoped one only the key",
    () =>
      Effect.gen(function* () {
        const deployment = yield* Effect.scoped(Layer.build(perDeployment.layer(built)));
        assert.deepStrictEqual(Context.get(deployment, Knobs), built);
        assert.strictEqual(
          Context.get(deployment, Tenant.DeploymentConfigApplied).key,
          "test/TenantConfigScope/Knobs",
        );
        const tenant = yield* Effect.scoped(Layer.build(perTenant.layer(built)));
        assert.isUndefined(Context.getOrUndefined(tenant, Tenant.DeploymentConfigApplied));
      }),
  );
});
