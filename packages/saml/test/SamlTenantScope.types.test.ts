// Plan 36 ticket 16: a shipped deployment-scoped `config(...)` (SSO, SAML) in a tenant lookup is refused at
// `TenantMiddleware.layerWithConfig` (BEH-EA-355). Nothing runs: each `@ts-expect-error` is the assertion.
import { Tenant } from "@awthaq/core";
import { TenantMiddleware } from "@awthaq/organization";
import { describe, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Saml from "../src/SamlConfig.ts";
import * as Sso from "../src/Sso.ts";

class AllowedLookup extends LayerMap.Service<AllowedLookup>()("test/SamlTenantScope/Allowed", {
  lookup: (tenantId: string) => Tenant.configApplied(tenantId),
}) {}

class SsoLookup extends LayerMap.Service<SsoLookup>()("test/SamlTenantScope/Sso", {
  lookup: (tenantId: string) =>
    Layer.merge(Sso.config({ preferred: "oidc" }), Tenant.configApplied(tenantId)),
}) {}

class SamlLookup extends LayerMap.Service<SamlLookup>()("test/SamlTenantScope/Saml", {
  lookup: (tenantId: string) =>
    Layer.merge(
      Saml.config({ baseUrl: "https://app.example.com" }),
      Tenant.configApplied(tenantId),
    ),
}) {}

// Never called: only the types matter.
const compileTimeChecks = () => {
  TenantMiddleware.layerWithConfig(AllowedLookup);
  // @ts-expect-error a deployment-scoped SSO layer in a tenant lookup is refused
  TenantMiddleware.layerWithConfig(SsoLookup);
  // @ts-expect-error a deployment-scoped SAML layer in a tenant lookup is refused
  TenantMiddleware.layerWithConfig(SamlLookup);
};

describe("SAML and SSO config cannot ride a tenant lookup (BEH-EA-355)", () => {
  it("is a compile-time fact", () => {
    void compileTimeChecks;
  });
});
