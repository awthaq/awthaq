// Plan 05, phase 1: `TenantScoped`, the one tenant interface for a plugin's records. The SQL
// predicate and the memory matcher are one rule, so they are compared on a grid of
// row tenant x visibility against a real (in-memory SQLite) table.
import { Tenant } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TenantScope from "../src/TenantScope.ts";
import * as TenantScoped from "../src/TenantScoped.ts";
import * as TestSql from "../../test/src/TestSql.ts";

const rows: ReadonlyArray<{ readonly id: string; readonly tenantId: string | null }> = [
  { id: "a", tenantId: "t1" },
  { id: "b", tenantId: "t2" },
  { id: "c", tenantId: null },
];

const grant = TenantScoped.crossTenant("test: every tenant");

const seen = [
  ["no tenant", TenantScoped.Visibility.Tenant({ tenant: Option.none() })],
  ["tenant t1", TenantScoped.Visibility.Tenant({ tenant: Option.some("t1") })],
  ["tenant t2", TenantScoped.Visibility.Tenant({ tenant: Option.some("t2") })],
  ["tenant with no rows", TenantScoped.Visibility.Tenant({ tenant: Option.some("t3") })],
  ["everywhere", TenantScoped.Visibility.Everywhere({ grant })],
] as const;

describe("TenantScoped", () => {
  it.effect("the SQL predicate and the memory matcher agree on every row x visibility", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE scoped_probe (id TEXT PRIMARY KEY, "tenantId" TEXT)`;
      for (const row of rows) {
        yield* sql`INSERT INTO scoped_probe (id, "tenantId") VALUES (${row.id}, ${row.tenantId})`;
      }
      for (const [name, visibility] of seen) {
        const viaSql = yield* sql<{ readonly id: string }>`
          SELECT id FROM scoped_probe
          WHERE ${TenantScoped.predicate(sql, "tenantId", visibility)} ORDER BY id`;
        const viaMemory = rows.filter((row) => TenantScoped.matches(row.tenantId, visibility));
        assert.deepStrictEqual(
          viaSql.map((row) => row.id),
          viaMemory.map((row) => row.id),
          name,
        );
      }
    }).pipe(Effect.provide(TestSql.layer("tenant_scoped"))),
  );

  it.effect("a qualified predicate targets the aliased column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE scoped_parent (id TEXT PRIMARY KEY, "tenantId" TEXT)`;
      yield* sql`CREATE TABLE scoped_child (id TEXT PRIMARY KEY, "parentId" TEXT)`;
      yield* sql`INSERT INTO scoped_parent (id, "tenantId") VALUES ('p1', 't1'), ('p2', 't2')`;
      yield* sql`INSERT INTO scoped_child (id, "parentId") VALUES ('c1', 'p1'), ('c2', 'p2')`;
      const mine = yield* sql<{ readonly id: string }>`
        SELECT c.id FROM scoped_child c
        WHERE EXISTS (SELECT 1 FROM scoped_parent e WHERE e.id = c."parentId"
          AND ${TenantScoped.predicate(
            sql,
            "tenantId",
            TenantScoped.Visibility.Tenant({ tenant: Option.some("t2") }),
            "e",
          )})`;
      assert.deepStrictEqual(
        mine.map((row) => row.id),
        ["c2"],
      );
    }).pipe(Effect.provide(TestSql.layer("tenant_scoped_qualified"))),
  );

  it.effect(
    "the predicate never uses IS NOT DISTINCT FROM (a btree index could not serve it)",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [, visibility] of seen) {
          const [text] =
            sql`SELECT 1 WHERE ${TenantScoped.predicate(sql, "tenantId", visibility)}`.compile();
          assert.notInclude(text, "DISTINCT");
        }
      }).pipe(Effect.provide(TestSql.layer("tenant_scoped_compile"))),
  );

  it.effect("stamp: an explicit tenant wins, then the ambient one, then NULL", () =>
    Effect.gen(function* () {
      const explicit = yield* TenantScoped.stamp({ tenantId: "own" }).pipe(
        Tenant.withTenant("ambient"),
      );
      assert.strictEqual(explicit.tenantId, "own");
      const ambient = yield* TenantScoped.stamp({ tenantId: null }).pipe(
        Tenant.withTenant("ambient"),
      );
      assert.strictEqual(ambient.tenantId, "ambient");
      const none = yield* TenantScoped.stamp({ tenantId: null });
      assert.strictEqual(none.tenantId, null);
    }),
  );

  it.effect("visibility is the ambient tenant, or Everywhere when a witness is presented", () =>
    Effect.gen(function* () {
      const ambient = yield* TenantScoped.visibility().pipe(Tenant.withTenant("t1"));
      assert.isTrue(TenantScoped.matches("t1", ambient));
      assert.isFalse(TenantScoped.matches("t2", ambient));
      const lifted = yield* TenantScoped.visibility(grant).pipe(Tenant.withTenant("t1"));
      assert.isTrue(TenantScoped.matches("t2", lifted));
      assert.isTrue(TenantScoped.matches(null, lifted));
    }),
  );

  it.effect("lift is a no-op outside an RLS transaction (no withTenant, the relay, SQLite)", () =>
    Effect.gen(function* () {
      const value = yield* Effect.succeed(42).pipe(TenantScoped.lift(grant));
      assert.strictEqual(value, 42);
      // Outside withTenant there is no RLS scope on either backend.
      assert.isFalse(yield* Effect.service(TenantScoped.InRlsScope));
      // withTenant opens an RLS transaction on Postgres only; on SQLite it provides just
      // the ambient tenant. The suite runs on both, so assert each backend's contract.
      const inScope = yield* Effect.service(TenantScoped.InRlsScope).pipe(
        TenantScope.withTenant("t1"),
      );
      assert.strictEqual(inScope, process.env["AWTHAQ_POSTGRES_URL"] !== undefined);
    }).pipe(Effect.provide(TestSql.layer("tenant_scoped_lift"))),
  );

  it.effect("liftOn provides the captured client, so a witnessed method needs no SqlClient", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const value = yield* Effect.succeed(7).pipe(TenantScoped.liftOn(sql, grant));
      assert.strictEqual(value, 7);
    }).pipe(Effect.provide(TestSql.layer("tenant_scoped_lift_on"))),
  );
});

describe("TenantScope.coverage", () => {
  const declared = [
    { plugin: "webhooks", table: "webhooks_endpoint", tenancy: TenantScoped.partitioned() },
    {
      plugin: "webhooks",
      table: "webhooks_delivery",
      tenancy: TenantScoped.derived("webhooks_endpoint", "endpointId"),
    },
    { plugin: "organization", table: "organization_org", tenancy: TenantScoped.keyed("id") },
    {
      plugin: "organization",
      table: "organization_team",
      tenancy: TenantScoped.keyed("organizationId"),
    },
    {
      plugin: "organization",
      table: "organization_team_membership",
      tenancy: TenantScoped.derived("organization_team", "teamId"),
    },
    {
      plugin: "organization",
      table: "organization_active_context",
      tenancy: TenantScoped.derived("sessions", "sessionId"),
    },
    { plugin: "jwt", table: "jwt_signing_key", tenancy: TenantScoped.global("deployment-wide") },
  ];
  const tables = (options: TenantScope.RlsOptions | undefined) =>
    TenantScope.coverage(options).covered.map((cover) => cover.table);

  it("covers the core partitioned tables only, by default", () => {
    assert.deepStrictEqual(tables(undefined), [...TenantScope.partitionedTables]);
    assert.deepStrictEqual(tables({ includeDirectory: true }), [
      ...TenantScope.partitionedTables,
      ...TenantScope.directoryTables,
    ]);
  });

  it("covers declared Partitioned tables and Derived tables through a covered parent", () => {
    const covered = tables({ plugins: declared });
    assert.include(covered, "webhooks_endpoint");
    assert.include(covered, "webhooks_delivery");
    // `sessions` is a covered core table, so the active-context child is covered through it.
    assert.include(covered, "organization_active_context");
    assert.notInclude(covered, "organization_org");
    assert.notInclude(covered, "organization_team");
    assert.notInclude(covered, "jwt_signing_key");
  });

  it("covers Keyed tables, and Derived tables beneath them, only on request", () => {
    const options = { plugins: declared, includeKeyed: true };
    const covered = tables(options);
    assert.include(covered, "organization_org");
    assert.include(covered, "organization_team");
    assert.include(covered, "organization_team_membership");
    assert.notInclude(covered, "jwt_signing_key");
  });

  it("skips a Derived table whose parent is not covered, and says so", () => {
    const plan = TenantScope.coverage({ plugins: declared });
    assert.deepStrictEqual(
      plan.skipped.map((skipped) => skipped.table),
      ["organization_team_membership"],
    );
  });

  it("a Derived table names its parent key and join column in the policy", () => {
    const delivery = TenantScope.coverage({ plugins: declared }).covered.find(
      (cover) => cover.table === "webhooks_delivery",
    );
    assert.deepStrictEqual(delivery, {
      table: "webhooks_delivery",
      kind: "parent",
      parent: "webhooks_endpoint",
      via: "endpointId",
      parentKey: "id",
    });
  });
});
