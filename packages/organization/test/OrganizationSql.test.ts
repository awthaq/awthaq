// `Organization` composed over the real SQL records layers, a real (SQLite)
// `SqlClient`, the plugin's own migrations, and `SqlTransaction.layerSql` —
// the composition the memory-backed `Organization.test.ts` cannot exercise.
// Failures are injected with database triggers, so every assertion is about
// what the database actually holds afterwards.
import { Api } from "@awthaq/api";
import { Migrations, Sessions, Users } from "@awthaq/core";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";
import * as InvitationRecords from "../src/InvitationRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";
import * as OrganizationRecords from "../src/OrganizationRecords.ts";
import * as OrgRoleRecords from "../src/OrgRoleRecords.ts";
import * as TeamRecords from "../src/TeamRecords.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";
import { TestAuth } from "@awthaq/test";

const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
  Layer.provideMerge(TestAuth.memoryFoundation),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("organization-sql-test-csrf-secret"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const SqlLive = TestSql.layer("organization_OrganizationSql");

const Migrated = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
  Layer.provide(SqlLive),
);

const sqlRecords = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(Layer.provide(NodeCrypto.layer));

// Every records layer shares the one migrated in-memory database.
const OrganizationSqlLive = Organization.Organization.layer.pipe(
  Layer.provide(
    Organization.config({
      dynamicAccessControl: { enabled: true, maximumRolesPerOrganization: 10 },
      teams: {
        enabled: true,
        maximumTeams: Number.POSITIVE_INFINITY,
        maximumMembersPerTeam: Number.POSITIVE_INFINITY,
        allowRemovingAllTeams: true,
      },
    }),
  ),
  Layer.provide(AuthenticationLive),
  Layer.provide(CsrfProtectionLive),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(sqlRecords(OrganizationRecords.layerSql)),
  Layer.provideMerge(sqlRecords(MembershipRecords.layerSql)),
  Layer.provideMerge(ActiveContextRecords.layerSql),
  Layer.provideMerge(sqlRecords(InvitationRecords.layerSql)),
  Layer.provideMerge(sqlRecords(OrgRoleRecords.layerSql)),
  Layer.provideMerge(sqlRecords(TeamRecords.layerSql)),
  Layer.provideMerge(Mailer.layerMemory),
  Layer.provideMerge(SqlTransaction.layerSql),
  Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  Layer.provideMerge(Migrated),
  Layer.provideMerge(SqlLive),
);

const asCaller = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `${id}-session`,
  });

const countRows = (sql: SqlClient.SqlClient, table: string) =>
  sql.unsafe(`SELECT COUNT(*) AS n FROM ${table}`).pipe(
    Effect.map((rows) => {
      const first = rows[0];
      return typeof first === "object" && first !== null && "n" in first ? Number(first.n) : -1;
    }),
  );

describe("Organization over SQL (OHS-002)", () => {
  it.effect("delete rolls back the whole cascade when the final organization delete fails", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const sql = yield* SqlClient.SqlClient;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.invite(owner, org.id, { email: "new@example.com", role: ["member"] });
      const team = yield* organization.createTeam(owner, org.id, "Engineering");
      yield* organization.addTeamMember(owner, org.id, team.id, Users.UserId("owner-1"));
      yield* organization.createRole(owner, org.id, {
        role: "billing",
        permission: { organization: ["update"] },
      });

      yield* TestSql.injectFailure({
        name: "fail_org_delete",
        table: "organization_org",
        event: "DELETE",
      });
      const exit = yield* Effect.exit(organization.delete(owner, org.id));
      assert.isTrue(Exit.isFailure(exit));

      // Nothing was removed: every cascade step before the failing one rolled back.
      assert.strictEqual(yield* countRows(sql, "organization_membership"), 1);
      assert.strictEqual(yield* countRows(sql, "organization_invitation"), 1);
      assert.strictEqual(yield* countRows(sql, "organization_team"), 1);
      assert.strictEqual(yield* countRows(sql, "organization_team_membership"), 1);
      assert.strictEqual(yield* countRows(sql, "organization_role"), 1);
      assert.strictEqual(yield* countRows(sql, "organization_org"), 1);
    }).pipe(Effect.provide(OrganizationSqlLive)),
  );

  it.effect("delete without a failure removes every organization_* row", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const sql = yield* SqlClient.SqlClient;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.createTeam(owner, org.id, "Engineering");
      yield* organization.delete(owner, org.id);
      assert.strictEqual(yield* countRows(sql, "organization_membership"), 0);
      assert.strictEqual(yield* countRows(sql, "organization_team"), 0);
      assert.strictEqual(yield* countRows(sql, "organization_org"), 0);
    }).pipe(Effect.provide(OrganizationSqlLive)),
  );

  it.effect("removeTeam rolls back when the team delete cannot complete", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const sql = yield* SqlClient.SqlClient;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const team = yield* organization.createTeam(owner, org.id, "Engineering");
      yield* organization.addTeamMember(owner, org.id, team.id, Users.UserId("owner-1"));
      yield* TestSql.injectFailure({
        name: "fail_team_membership_delete",
        table: "organization_team_membership",
        event: "DELETE",
      });
      const exit = yield* Effect.exit(organization.removeTeam(owner, org.id, team.id));
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(yield* countRows(sql, "organization_team"), 1);
      assert.strictEqual(yield* countRows(sql, "organization_team_membership"), 1);
    }).pipe(Effect.provide(OrganizationSqlLive)),
  );
});
