// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `Organization`.
import { SessionLifecycle } from "@awthaq/api";
import * as OrganizationApi from "../src/OrganizationApi.ts";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Migrations } from "@awthaq/core";
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient";
import * as Effect from "effect/Effect";
import * as ConnectionRecords from "../src/ConnectionRecords.ts";
import * as Organization from "../src/Organization.ts";
import { activeContextRecords } from "./contract/ActiveContextRecords.ts";
import { connectionRecords } from "./contract/ConnectionRecords.ts";
import { domainClaims } from "./contract/DomainClaims.ts";
import { invitationRecords } from "./contract/InvitationRecords.ts";
import { membershipRecords } from "./contract/MembershipRecords.ts";
import { organizationRecords } from "./contract/OrganizationRecords.ts";
import { orgRoleRecords } from "./contract/OrgRoleRecords.ts";
import { teamRecords } from "./contract/TeamRecords.ts";

/** `ConnectionRecords.layerSql` over a fresh libSQL file per case, migrated, removed when the case's scope closes. */
const ConnectionsOverLibsql = ConnectionRecords.layerSql.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
      Layer.provideMerge(
        Layer.unwrap(
          Effect.map(
            Effect.acquireRelease(
              Effect.sync(() => mkdtempSync(join(tmpdir(), "awthaq-connection-records-libsql-"))),
              (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
            ),
            (dir) => LibsqlClient.layer({ url: `file:${join(dir, "auth.db")}` }),
          ),
        ),
      ),
    ),
  ),
);

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => Organization.Organization, {
  options: [{}],
  records: {
    suite: "organization_records_contract",
    suites: {
      "awthaq/organization/records/OrganizationRecords": organizationRecords,
      "awthaq/organization/records/MembershipRecords": membershipRecords,
      "awthaq/organization/records/ActiveContextRecords": activeContextRecords,
      "awthaq/organization/records/InvitationRecords": invitationRecords,
      "awthaq/organization/records/OrgRoleRecords": orgRoleRecords,
      "awthaq/organization/records/TeamRecords": teamRecords,
      "awthaq/organization/records/ConnectionRecords": connectionRecords,
      "awthaq/organization/records/DomainClaims": domainClaims,
    },
    // Plan 28: libSQL reports a duplicate domain as a `ConstraintError`, so the connection suite runs there too.
    adapters: [
      {
        name: "libSQL",
        stores: ["awthaq/organization/records/ConnectionRecords"],
        layer: ConnectionsOverLibsql,
      },
    ],
  },
  build: { services: Layer.empty },
});

// ADR-EA-045 (BEH-EA-343): the session lifecycle this plugin declares, pinned where its contract lives.
describe("session lifecycle", () => {
  it("OrganizationApi declares each endpoint's session lifecycle", () => {
    assert.deepStrictEqual(
      Object.fromEntries(SessionLifecycle.inventory(OrganizationApi.OrganizationApi)),
      {
        "organization.setActive": "refreshes",
        "organization.setActiveTeam": "refreshes",
        "organization.leave": "refreshes",
        "organization.acceptInvitation": "refreshes",
      },
    );
  });
});
