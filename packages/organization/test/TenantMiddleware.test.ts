// EP-001/BEH-EA-229 (ADR-EA-018): `Organization.tenantMiddleware` resolves the
// application's `TenantResolver` once per request and provides `TenantContext`
// for the handler's fiber. Exercised over a real Node HTTP server, the way
// `packages/server/test/BodyLimit.test.ts` exercises the other global router
// middleware.
import { Tenant } from "@awthaq/ports";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Organization from "../src/Organization.ts";
import * as OrganizationRecords from "../src/OrganizationRecords.ts";
import * as TenantResolver from "../src/TenantResolver.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

/** Reports the ambient tenant the handler's fiber sees. */
const whoami = HttpRouter.add(
  "GET",
  "/whoami",
  Effect.gen(function* () {
    const tenant = yield* Tenant.TenantContext;
    return HttpServerResponse.jsonUnsafe({ tenant: Option.getOrNull(tenant) });
  }),
);

/** The application's own routing convention: an `x-tenant` header. */
const headerResolver = TenantResolver.TenantResolver.layer((request) =>
  Effect.succeed(Option.fromNullishOr(request.headers["x-tenant"])),
);

const serveWith = (
  middleware: Layer.Layer<
    never,
    never,
    | HttpRouter.HttpRouter
    | TenantResolver.TenantResolver
    | OrganizationRecords.OrganizationRecords
    | SqlClient.SqlClient
  >,
) =>
  Effect.gen(function* () {
    const records = Context.get(
      yield* Layer.build(OrganizationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
      OrganizationRecords.OrganizationRecords,
    );
    yield* whoami.pipe(
      Layer.provide(middleware),
      Layer.provide(headerResolver),
      Layer.provide(Layer.succeed(OrganizationRecords.OrganizationRecords, records)),
      Layer.provide(TestSql.layer("organization_TenantMiddleware")),
      HttpRouter.serve,
      Layer.build,
    );
    return records;
  });

const tenantSeenBy = (headers: Record<string, string>, path = "/whoami") =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(path, { headers });
    return { status: response.status, body: yield* response.json };
  });

describe("Organization.tenantMiddleware (BEH-EA-229)", () => {
  it.effect("provides the resolved organization as the ambient tenant", () =>
    Effect.gen(function* () {
      const records = yield* serveWith(Organization.tenantMiddleware);
      const acme = yield* records.create({ name: "Acme", slug: "acme" });
      const seen = yield* tenantSeenBy({ "x-tenant": acme.id });
      assert.strictEqual(seen.status, 200);
      assert.deepStrictEqual(seen.body, { tenant: acme.id });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("a request the resolver leaves untenanted runs with no tenant", () =>
    Effect.gen(function* () {
      yield* serveWith(Organization.tenantMiddleware);
      const seen = yield* tenantSeenBy({});
      assert.strictEqual(seen.status, 200);
      assert.deepStrictEqual(seen.body, { tenant: null });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("an id naming no organization is refused, never run untenanted", () =>
    Effect.gen(function* () {
      yield* serveWith(Organization.tenantMiddleware);
      const seen = yield* tenantSeenBy({ "x-tenant": "no-such-org" });
      assert.strictEqual(seen.status, 404);
      assert.deepStrictEqual(seen.body, {
        _tag: "OrganizationNotFound",
        message: "awthaq: no such organization",
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("a suspended organization still resolves (the plugin's own gate refuses it)", () =>
    Effect.gen(function* () {
      const records = yield* serveWith(Organization.tenantMiddleware);
      const acme = yield* records.create({ name: "Acme", slug: "acme" });
      yield* records.setSuspended(acme.id, Option.some(yield* DateTime.now));
      const seen = yield* tenantSeenBy({ "x-tenant": acme.id });
      assert.deepStrictEqual(seen.body, { tenant: acme.id });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("the RLS variant provides the same ambient tenant (no-op scope off Postgres)", () =>
    Effect.gen(function* () {
      const records = yield* serveWith(Organization.tenantMiddlewareWithRls);
      const acme = yield* records.create({ name: "Acme", slug: "acme" });
      const seen = yield* tenantSeenBy({ "x-tenant": acme.id });
      assert.deepStrictEqual(seen.body, { tenant: acme.id });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});

// ---- EP-007/BEH-EA-231: the tenant's configuration layers ride the request ----------------------

/** The application's own tenant settings (a database table in real life). */
const limits = new Map<string, number>();

class TenantConfig extends LayerMap.Service<TenantConfig>()("test/TenantMiddleware/TenantConfig", {
  lookup: (tenantId: string) =>
    Layer.merge(
      Organization.config({ membershipLimit: limits.get(tenantId) ?? 50 }),
      Tenant.configApplied(tenantId),
    ),
  idleTimeToLive: "1 minute",
}) {}

/** Reports the membership limit of the configuration in force for the handler's fiber. */
const limitInForce = HttpRouter.add(
  "GET",
  "/limit",
  Effect.gen(function* () {
    const config = yield* Organization.OrganizationConfig;
    const applied = yield* Effect.serviceOption(Tenant.TenantConfigApplied);
    return HttpServerResponse.jsonUnsafe({
      membershipLimit: config.membershipLimit,
      appliedTenant: Option.match(applied, { onNone: () => null, onSome: (a) => a.tenantId }),
    });
  }),
);

describe("Organization.tenantMiddlewareWithConfig (BEH-EA-231)", () => {
  it.effect("each tenant's request runs under that tenant's own configuration", () =>
    Effect.gen(function* () {
      const records = Context.get(
        yield* Layer.build(OrganizationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
        OrganizationRecords.OrganizationRecords,
      );
      yield* limitInForce.pipe(
        Layer.provide(Organization.tenantMiddlewareWithConfig(TenantConfig)),
        Layer.provide(headerResolver),
        Layer.provide(Layer.succeed(OrganizationRecords.OrganizationRecords, records)),
        Layer.provide(TenantConfig.layer),
        HttpRouter.serve,
        Layer.build,
      );
      const small = yield* records.create({ name: "Small", slug: "small" });
      const big = yield* records.create({ name: "Big", slug: "big" });
      limits.set(small.id, 1);
      limits.set(big.id, 50);
      const smallSeen = yield* tenantSeenBy({ "x-tenant": small.id }, "/limit");
      assert.deepStrictEqual(smallSeen.body, { membershipLimit: 1, appliedTenant: small.id });
      const bigSeen = yield* tenantSeenBy({ "x-tenant": big.id }, "/limit");
      assert.deepStrictEqual(bigSeen.body, { membershipLimit: 50, appliedTenant: big.id });
      const untenanted = yield* tenantSeenBy({}, "/limit");
      // No tenant: the build-time (here: default) configuration, and no tenant marker.
      assert.deepStrictEqual(untenanted.body, { membershipLimit: 100, appliedTenant: null });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
