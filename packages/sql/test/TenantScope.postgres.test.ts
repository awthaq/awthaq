// Plan 05, phase 1: the Postgres row-level-security backstop, in one place. The first block is the
// core-table RLS suite moved here unchanged from `Repositories.postgres.test.ts`; the second adds
// the plugin-table policies per tenancy kind and `TenantScoped.lift`.
//
// Skips (not fails) without `AWTHAQ_POSTGRES_URL`. The suite connects as a superuser, which
// bypasses RLS by definition, so each probe drops to a plain non-owner role (`SET LOCAL ROLE`)
// inside the tenant transaction.
import * as PgClient from "@effect/sql-pg/PgClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Model from "effect/unstable/schema/Model";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Models from "../src/Models.ts";
import * as Repositories from "../src/Repositories.ts";
import * as TenantScope from "../src/TenantScope.ts";
import * as TenantScoped from "../src/TenantScoped.ts";
import { repositoriesLayer } from "./contract.ts";

const M = Models.makeModels("pg");

const postgresUrl = process.env["AWTHAQ_POSTGRES_URL"];

const skip = postgresUrl === undefined;

const SqlLive = PgClient.layer({ url: Redacted.make(postgresUrl ?? "") });

// Same table list and drop-and-recreate discipline as `Repositories.postgres.test.ts`.
const coreTables = [
  "users",
  "accounts",
  "sessions",
  "verification_tokens",
  "verification_reservations",
  "auth_audit_log",
  "auth_relay_cursor",
  "effect_sql_migrations",
];

const RepositoriesLive = repositoriesLayer(
  SqlLive,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const table of coreTables) {
      yield* sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
  }),
);

// DRS-001/SAM-006 (ADR-EA-018): the opt-in RLS backstop. The suite connects as a
// superuser, which bypasses RLS by definition, so each probe drops to a plain
// non-owner role (`SET LOCAL ROLE`) inside the tenant transaction — exactly the
// role a production application should run as.
describe.skipIf(skip)("Tenant RLS (real Postgres)", () => {
  const probeRole = "awthaq_rls_probe";

  const sessionFor = (userId: Models.UserId) =>
    M.Session.insert.make({
      userId,
      secretHash: "h",
      ipAddress: null,
      userAgent: null,
      absoluteExpiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
      idleExpiresAt: Model.Override(DateTime.makeUnsafe("2099-01-01T00:00:00.000Z")),
      actingAsType: null,
      actingAsId: null,
      familyId: Schema.decodeUnknownSync(Models.SessionId)("rls-family"),
      supersededBy: null,
      supersededAt: null,
      reusedAt: null,
    });

  /** Runs `body` with RLS on, and always turns it off again (the tables are shared with other cases). */
  const withRls = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(
          `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${probeRole}') THEN CREATE ROLE ${probeRole} NOLOGIN; END IF; END $$`,
        );
        yield* sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${probeRole}`);
        yield* TenantScope.enableRls();
      }),
      () => body,
      () => Effect.orDie(TenantScope.disableRls),
    );

  it.effect("a query inside withTenant('t1') cannot read or write t2's session rows", () =>
    withRls(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const users = yield* Repositories.UsersRepository;
        const sessions = yield* Repositories.SessionsRepository;
        const user = yield* users.insert(
          yield* M.User.insert.makeEffect({ email: "rls@example.com", name: "RLS" }),
        );
        const one = yield* sessions.insert(sessionFor(user.id)).pipe(TenantScope.withTenant("t1"));
        const two = yield* sessions.insert(sessionFor(user.id)).pipe(TenantScope.withTenant("t2"));
        assert.strictEqual(one.tenantId, "t1");
        assert.strictEqual(two.tenantId, "t2");

        const visibleTo = (tenant: string) =>
          Effect.andThen(
            sql.unsafe(`SET LOCAL ROLE ${probeRole}`),
            sql<{ readonly id: string }>`SELECT id FROM sessions WHERE "userId" = ${user.id}`,
          ).pipe(TenantScope.withTenant(tenant));

        assert.deepStrictEqual(
          (yield* visibleTo("t1")).map((row) => row.id),
          [one.id],
        );
        assert.deepStrictEqual(
          (yield* visibleTo("t2")).map((row) => row.id),
          [two.id],
        );

        // No tenant in scope: fail-open by design (single-tenant, migrations, maintenance).
        const unscoped = yield* sql.withTransaction(
          Effect.andThen(
            sql.unsafe(`SET LOCAL ROLE ${probeRole}`),
            sql<{ readonly id: string }>`SELECT id FROM sessions WHERE "userId" = ${user.id}`,
          ),
        );
        assert.strictEqual(unscoped.length, 2);

        // Another tenant's row can be neither updated nor forged.
        const crossTenantWrite = yield* Effect.andThen(
          sql.unsafe(`SET LOCAL ROLE ${probeRole}`),
          sql`UPDATE sessions SET "userAgent" = 'x' WHERE id = ${two.id} RETURNING id`,
        ).pipe(TenantScope.withTenant("t1"));
        assert.strictEqual(crossTenantWrite.length, 0);
        const forgedInsert = yield* Effect.andThen(
          sql.unsafe(`SET LOCAL ROLE ${probeRole}`),
          sql`INSERT INTO sessions ${sql.insert({
            id: "forged",
            userId: user.id,
            secretHash: "h",
            absoluteExpiresAt: new Date("2099-01-01T00:00:00Z"),
            idleExpiresAt: new Date("2099-01-01T00:00:00Z"),
            createdAt: new Date(),
            authenticatedAt: new Date(),
            lastActiveAt: new Date(),
            familyId: "forged",
            tenantId: "t2",
          })}`,
        ).pipe(TenantScope.withTenant("t1"), Effect.flip);
        assert.strictEqual(forgedInsert._tag, "SqlError");
      }),
    ).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("enableRls and disableRls are idempotent, and the directory tables are opt-in", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rlsOn = (table: string) =>
        sql<{ readonly relrowsecurity: boolean }>`
          SELECT relrowsecurity FROM pg_class WHERE relname = ${table} AND relnamespace = 'public'::regnamespace
        `.pipe(Effect.map((rows) => rows[0]?.relrowsecurity ?? false));

      yield* TenantScope.enableRls();
      yield* TenantScope.enableRls();
      assert.isTrue(yield* rlsOn("sessions"));
      assert.isFalse(yield* rlsOn("users"));
      yield* TenantScope.enableRls({ includeDirectory: true });
      assert.isTrue(yield* rlsOn("users"));
      yield* TenantScope.disableRls;
      yield* TenantScope.disableRls;
      assert.isFalse(yield* rlsOn("sessions"));
      assert.isFalse(yield* rlsOn("users"));
    }).pipe(Effect.provide(RepositoriesLive)),
  );
});

// Plan 05 (ADR-EA-018 decision 10): plugin tables. Scratch tables stand in for a Partitioned
// parent, a Derived child and a Keyed table, so the policy of each kind is checked against a real
// server without a plugin.
describe.skipIf(skip)("Plugin-table RLS (real Postgres)", () => {
  const probeRole = "awthaq_rls_probe";
  const grant = TenantScoped.crossTenant("test: every tenant");

  const plugins: ReadonlyArray<TenantScope.DeclaredTable> = [
    { plugin: "probe", table: "rls_parent", tenancy: TenantScoped.partitioned() },
    {
      plugin: "probe",
      table: "rls_child",
      tenancy: TenantScoped.derived("rls_parent", "parentId"),
    },
    { plugin: "probe", table: "rls_keyed", tenancy: TenantScoped.keyed("organizationId") },
    { plugin: "probe", table: "rls_global", tenancy: TenantScoped.global("test") },
  ];

  const scratch = ["rls_child", "rls_parent", "rls_keyed", "rls_global"];

  /** Creates the scratch tables with rows for t1, t2 and no tenant, and always cleans up. */
  const withScratch = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const table of scratch) yield* sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
        yield* sql.unsafe(`CREATE TABLE rls_parent (id TEXT PRIMARY KEY, "tenantId" TEXT)`);
        yield* sql.unsafe(`CREATE TABLE rls_child (id TEXT PRIMARY KEY, "parentId" TEXT)`);
        yield* sql.unsafe(`CREATE TABLE rls_keyed (id TEXT PRIMARY KEY, "organizationId" TEXT)`);
        yield* sql.unsafe(`CREATE TABLE rls_global (id TEXT PRIMARY KEY)`);
        yield* sql`INSERT INTO rls_parent (id, "tenantId") VALUES ('p1', 't1'), ('p2', 't2'), ('p0', NULL)`;
        yield* sql`INSERT INTO rls_child (id, "parentId") VALUES ('c1', 'p1'), ('c2', 'p2'), ('c0', 'p0')`;
        yield* sql`INSERT INTO rls_keyed (id, "organizationId") VALUES ('k1', 't1'), ('k2', 't2')`;
        yield* sql`INSERT INTO rls_global (id) VALUES ('g1')`;
        yield* sql.unsafe(
          `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${probeRole}') THEN CREATE ROLE ${probeRole} NOLOGIN; END IF; END $$`,
        );
        yield* sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${probeRole}`);
      }),
      () => body,
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* TenantScope.disableRls;
          for (const table of scratch) yield* sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
        }).pipe(Effect.orDie),
    );

  /** `select` as the probe role, inside `withTenant(tenant)`: ids a plain unfiltered statement sees. */
  const idsIn = (tenant: string, table: string, wrap = <A, E, R>(e: Effect.Effect<A, E, R>) => e) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`SET LOCAL ROLE ${probeRole}`);
      const rows = yield* wrap(
        sql.unsafe<{ readonly id: string }>(`SELECT id FROM ${table} ORDER BY id`),
      );
      return rows.map((row) => row.id);
    }).pipe(TenantScope.withTenant(tenant));

  it.effect(
    "a Partitioned table is confined to the tenant; a Derived table follows its parent",
    () =>
      withScratch(
        Effect.gen(function* () {
          yield* TenantScope.enableRls({ plugins });
          assert.deepStrictEqual(yield* idsIn("t1", "rls_parent"), ["p1"]);
          assert.deepStrictEqual(yield* idsIn("t2", "rls_parent"), ["p2"]);
          assert.deepStrictEqual(yield* idsIn("t1", "rls_child"), ["c1"]);
          assert.deepStrictEqual(yield* idsIn("t2", "rls_child"), ["c2"]);
          // Keyed and Global tables are not covered by default.
          assert.deepStrictEqual(yield* idsIn("t1", "rls_keyed"), ["k1", "k2"]);
          assert.deepStrictEqual(yield* idsIn("t1", "rls_global"), ["g1"]);
        }),
      ).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("Keyed tables are covered on request", () =>
    withScratch(
      Effect.gen(function* () {
        yield* TenantScope.enableRls({ plugins, includeKeyed: true });
        assert.deepStrictEqual(yield* idsIn("t1", "rls_keyed"), ["k1"]);
        assert.deepStrictEqual(yield* idsIn("t2", "rls_keyed"), ["k2"]);
        assert.deepStrictEqual(yield* idsIn("t1", "rls_global"), ["g1"]);
      }),
    ).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("with no tenant in scope the policies stay fail-open", () =>
    withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* TenantScope.enableRls({ plugins });
        const all = yield* sql.withTransaction(
          Effect.andThen(
            sql.unsafe(`SET LOCAL ROLE ${probeRole}`),
            sql<{ readonly id: string }>`SELECT id FROM rls_parent ORDER BY id`,
          ),
        );
        assert.deepStrictEqual(
          all.map((row) => row.id),
          ["p0", "p1", "p2"],
        );
      }),
    ).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("an INSERT for another tenant is refused as an authorization error", () =>
    withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* TenantScope.enableRls({ plugins });
        const refused = yield* Effect.andThen(
          sql.unsafe(`SET LOCAL ROLE ${probeRole}`),
          sql`INSERT INTO rls_parent (id, "tenantId") VALUES ('forged', 't2')`,
        ).pipe(TenantScope.withTenant("t1"), Effect.flip);
        assert.strictEqual(refused._tag, "SqlError");
        assert.strictEqual(refused.reason._tag, "AuthorizationError");
      }),
    ).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("lift shows every tenant to one witnessed statement and restores the scope after", () =>
    withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* TenantScope.enableRls({ plugins });
        const observed = yield* Effect.gen(function* () {
          yield* sql.unsafe(`SET LOCAL ROLE ${probeRole}`);
          const select = sql<{ readonly id: string }>`SELECT id FROM rls_parent ORDER BY id`;
          const before = yield* select;
          const lifted = yield* select.pipe(TenantScoped.lift(grant));
          const after = yield* select;
          return { before, lifted, after };
        }).pipe(TenantScope.withTenant("t1"));
        assert.deepStrictEqual(
          observed.before.map((row) => row.id),
          ["p1"],
        );
        assert.deepStrictEqual(
          observed.lifted.map((row) => row.id),
          ["p0", "p1", "p2"],
        );
        assert.deepStrictEqual(
          observed.after.map((row) => row.id),
          ["p1"],
        );
      }),
    ).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect(
    "a lifted statement that fails leaves the tenant scope in force (savepoint revert)",
    () =>
      withScratch(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* TenantScope.enableRls({ plugins });
          const after = yield* Effect.gen(function* () {
            yield* sql.unsafe(`SET LOCAL ROLE ${probeRole}`);
            yield* Effect.fail("boom").pipe(TenantScoped.lift(grant), Effect.ignore);
            return yield* sql<{ readonly id: string }>`SELECT id FROM rls_parent ORDER BY id`;
          }).pipe(TenantScope.withTenant("t1"));
          assert.deepStrictEqual(
            after.map((row) => row.id),
            ["p1"],
          );
        }),
      ).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("lift outside a tenant scope is a plain statement", () =>
    withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly id: string;
        }>`SELECT id FROM rls_parent ORDER BY id`.pipe(TenantScoped.lift(grant));
        assert.strictEqual(rows.length, 3);
      }),
    ).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect(
    "disableRls removes the policy from every table that has one, including ones it did not enable",
    () =>
      withScratch(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* TenantScope.enableRls({ plugins, includeKeyed: true });
          const policyCount = sql<{ readonly n: string }>`
          SELECT count(*)::text AS n FROM pg_policies
          WHERE policyname = 'awthaq_tenant' AND tablename LIKE 'rls_%'`.pipe(
            Effect.map((rows) => Number(rows[0]?.n ?? "0")),
          );
          assert.strictEqual(yield* policyCount, 3);
          // No argument, no memory of what was enabled: it finds the policies itself.
          yield* TenantScope.disableRls;
          yield* TenantScope.disableRls;
          assert.strictEqual(yield* policyCount, 0);
          assert.deepStrictEqual(yield* idsIn("t1", "rls_parent"), ["p0", "p1", "p2"]);
        }),
      ).pipe(Effect.provide(RepositoriesLive)),
  );
});
