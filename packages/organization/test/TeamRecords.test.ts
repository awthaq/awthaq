// OHS-001: the hierarchy migration backfills a closure row for every team written before it. A migration test,
// over a database migrated in two steps; the store's behaviour is its RecordsContract suite
// (`test/contract/TeamRecords.ts`, run by `Contract.test.ts`).
import { Migrations } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Organization from "../src/Organization.ts";
import * as TeamRecords from "../src/TeamRecords.ts";
import { TestSql } from "@awthaq/test";

const SqlLive = TestSql.layer("organization_TeamRecords");

// The same records layer over an *unmigrated* database, for the backfill test.
const LegacySqlLayer = TeamRecords.layerSql.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(SqlLive),
);

describe("TeamRecords hierarchy migration", () => {
  const closureCount = (sql: SqlClient.SqlClient) =>
    sql.unsafe("SELECT COUNT(*) AS n FROM organization_team_closure").pipe(
      Effect.map((rows) => {
        const first = rows[0];
        return typeof first === "object" && first !== null && "n" in first ? Number(first.n) : -1;
      }),
    );

  it.effect(
    "the hierarchy migration backfills a closure self-row for every pre-existing team",
    () =>
      Effect.gen(function* () {
        const all = Organization.Organization.migrations;
        const at = all.findIndex((m) => m.name === "organization_team_hierarchy");
        assert.isTrue(at > 0);
        const sql = yield* SqlClient.SqlClient;
        // Schema as it stood before the hierarchy, with a team written under it.
        yield* Migrations.run(all.slice(0, at));
        yield* sql.unsafe(
          `INSERT INTO organization_team (id, name, "organizationId", "memberCount", "createdAt", "updatedAt")
         VALUES ('legacy-1', 'Legacy', 'org-1', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        );
        yield* Migrations.run(all);
        const records = yield* TeamRecords.TeamRecords;
        const found = yield* records.findTeamById("org-1", "legacy-1");
        assert.isTrue(Option.isSome(found) && Option.isNone(found.value.parentId));
        assert.strictEqual(yield* closureCount(sql), 1);
        // ... and it can be a parent straight away.
        const child = yield* records.createTeam({
          organizationId: "org-1",
          name: "Kid",
          parentId: "legacy-1",
        });
        assert.deepStrictEqual(
          (yield* records.getAncestors("org-1", child.id)).map((t) => t.name),
          ["Legacy"],
        );
      }).pipe(Effect.provide(LegacySqlLayer)),
  );
});
