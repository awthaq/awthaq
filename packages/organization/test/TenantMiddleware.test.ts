// EP-001/BEH-EA-234 (ADR-EA-018): `Organization.tenantMiddleware` resolves the
// application's `TenantResolver` once per request and provides `TenantContext`
// for the handler's fiber. Exercised over a real Node HTTP server, the way
// `packages/server/test/BodyLimit.test.ts` exercises the other global router
// middleware.
import { Migrations, Users } from "@awthaq/core";
import { Tenant } from "@awthaq/ports";
import { TenantScope } from "@awthaq/sql";
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
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationRecords from "../src/OrganizationRecords.ts";
import * as TenantResolver from "../src/TenantResolver.ts";
import { TestSql } from "@awthaq/test";
import { grant } from "./support.ts";

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

describe("Organization.tenantMiddleware (BEH-EA-234)", () => {
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
      yield* records.setSuspended(grant, acme.id, Option.some(yield* DateTime.now));
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

// ---- EP-007/BEH-EA-236: the tenant's configuration layers ride the request ----------------------

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

describe("Organization.tenantMiddlewareWithConfig (BEH-EA-236)", () => {
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

// ---- plan 05 phase 12: the database confines a handler that forgot its filter (real Postgres only) -----

/** A handler that deliberately forgets its tenant filter: any rows it sees, the database let it see. */
const countMembers = (probeRole: string, sql: SqlClient.SqlClient) =>
  HttpRouter.add(
    "GET",
    "/members/count",
    Effect.gen(function* () {
      // The application's role is not the table owner, which is what lets the policy apply.
      yield* sql.unsafe(`SET LOCAL ROLE ${probeRole}`);
      const rows = yield* sql.unsafe<{ readonly n: string }>(
        "SELECT count(*)::text AS n FROM organization_membership",
      );
      return HttpServerResponse.jsonUnsafe({ visible: Number(rows[0]?.n ?? "0") });
    }).pipe(Effect.orDie),
  );

describe.skipIf(process.env["AWTHAQ_POSTGRES_URL"] === undefined)(
  "Organization.tenantMiddlewareWithRls: the database is the backstop (real Postgres)",
  () => {
    const probeRole = "awthaq_mw_probe";
    const SqlLive = TestSql.layer("organization_TenantMiddleware_rls");
    const Migrated = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
      Layer.provide(SqlLive),
    );
    const Records = Layer.mergeAll(OrganizationRecords.layerSql, MembershipRecords.layerSql).pipe(
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(SqlLive),
      Layer.provideMerge(Migrated),
    );

    it.effect(
      "a request under tenant A that runs an unfiltered query sees only A's organization-keyed rows",
      () =>
        Effect.gen(function* () {
          const context = yield* Layer.build(Records);
          const orgs = Context.get(context, OrganizationRecords.OrganizationRecords);
          const members = Context.get(context, MembershipRecords.MembershipRecords);
          const sql = Context.get(context, SqlClient.SqlClient);
          const a = yield* orgs.create({ name: "A", slug: "rls-a" });
          const b = yield* orgs.create({ name: "B", slug: "rls-b" });
          yield* members.create({
            userId: Users.UserId("rls-user-a"),
            organizationId: a.id,
            role: ["owner"],
          });
          yield* members.create({
            userId: Users.UserId("rls-user-b"),
            organizationId: b.id,
            role: ["owner"],
          });
          yield* sql.unsafe(
            `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${probeRole}') THEN CREATE ROLE ${probeRole} NOLOGIN; END IF; END $$`,
          );
          yield* sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${probeRole}`);
          yield* TenantScope.enableRls({
            plugins: Object.entries(Organization.Organization.tenancy).map(
              ([table, declaration]) => ({
                plugin: "organization",
                table,
                tenancy: declaration.tenancy,
              }),
            ),
            includeKeyed: true,
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
          yield* Effect.addFinalizer(() =>
            Effect.orDie(
              TenantScope.disableRls.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
            ),
          );
          yield* countMembers(probeRole, sql).pipe(
            Layer.provide(Organization.tenantMiddlewareWithRls),
            Layer.provide(headerResolver),
            Layer.provide(Layer.succeed(OrganizationRecords.OrganizationRecords, orgs)),
            Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
            HttpRouter.serve,
            Layer.build,
          );
          const underA = yield* tenantSeenBy({ "x-tenant": a.id }, "/members/count");
          assert.deepStrictEqual(underA.body, { visible: 1 });
          const underB = yield* tenantSeenBy({ "x-tenant": b.id }, "/members/count");
          assert.deepStrictEqual(underB.body, { visible: 1 });
        }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
    );
  },
);
