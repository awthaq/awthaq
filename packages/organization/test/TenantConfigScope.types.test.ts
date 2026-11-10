// BEH-EA-355: a deployment-scoped `config(...)` layer provides `Tenant.DeploymentConfigApplied`, and a `TenantConfig`
// lookup is typed `LayerMap<string, TenantConfigApplied, never>` (invariant in the output), so a lookup that merges one
// does not type-check at `layerWithConfig`. Nothing runs: each `@ts-expect-error` is the assertion.
import { Tenant } from "@awthaq/core";
import { describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as TenantMiddleware from "../src/TenantMiddleware.ts";

interface KnobsShape {
  readonly limit: number;
}

const Knobs = Context.Reference<KnobsShape>("test/TenantConfigScope.types/Knobs", {
  defaultValue: () => ({ limit: 1 }),
});

const PerTenantKnobs = Tenant.perTenant(Knobs);
const PerDeploymentKnobs = Tenant.perDeployment(Knobs);

class AllowedLookup extends LayerMap.Service<AllowedLookup>()(
  "test/TenantConfigScope.types/Allowed",
  {
    lookup: (tenantId: string) =>
      Layer.merge(PerTenantKnobs.layer({ limit: 2 }), Tenant.configApplied(tenantId)),
  },
) {}

class RefusedLookup extends LayerMap.Service<RefusedLookup>()(
  "test/TenantConfigScope.types/Refused",
  {
    lookup: (tenantId: string) =>
      Layer.merge(PerDeploymentKnobs.layer({ limit: 2 }), Tenant.configApplied(tenantId)),
  },
) {}

// Never called: only the types matter.
const compileTimeChecks = () => {
  TenantMiddleware.layerWithConfig(AllowedLookup);
  // @ts-expect-error a deployment-scoped layer in a tenant lookup is refused
  TenantMiddleware.layerWithConfig(RefusedLookup);
  // @ts-expect-error `notAField` is not a field of the key's shape
  Tenant.perTenant(Knobs, { boot: ["notAField"] });
};

describe("a deployment-scoped config cannot ride a tenant lookup (BEH-EA-355)", () => {
  it("is a compile-time fact", () => {
    void compileTimeChecks;
  });
});
