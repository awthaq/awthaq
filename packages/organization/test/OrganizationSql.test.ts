// `Organization` composed over the real SQL records layers, a real (SQLite)
// `SqlClient`, the plugin's own migrations, and `SqlTransaction.layerSql` —
// the composition the memory-backed `Organization.test.ts` cannot exercise.
// Failures are injected with database triggers, so every assertion is about
// what the database actually holds afterwards.
import { Api } from "@awthaq/api";
import { Auth, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Organization from "../src/Organization.ts";
import { TestAuth, TestSql } from "@awthaq/test";

// Every record store shares the one migrated database `TestAuth.layer({ records: "sql" })` builds.
const OrganizationSqlLive = TestAuth.layer(Auth.make([Organization.Organization]), {
  records: "sql",
  suite: "organization_OrganizationSql",
  services: Organization.config({
    dynamicAccessControl: { enabled: true, maximumRolesPerOrganization: 10 },
    teams: {
      enabled: true,
      maximumTeams: Number.POSITIVE_INFINITY,
      maximumMembersPerTeam: Number.POSITIVE_INFINITY,
      allowRemovingAllTeams: true,
    },
  }),
});

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
