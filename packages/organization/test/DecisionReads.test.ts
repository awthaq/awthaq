// RRC-003 / BEH-EA-162: authorization decisions read organization membership from the primary.
//
// `@awthaq/sql`'s `ReadRouting` lets a configured read replica serve reads that opt in
// (`consistency: "eventual"`); every organization record method a decision depends on
// (`MembershipRecords.findByUserAndOrg`, `TeamRecords.findTeamMembership`, `OrgRoleRecords`'s
// lookups, `ActiveContextRecords.findBySessionId`) takes no such option, so it reads the primary
// and a removed member is unrelated on the very next decision, however far behind a replica is.
// This pins that: a replica is configured and still holds the membership; the member is removed
// on the primary; the next decision read must not see it.
import { Migrations, Users } from "@awthaq/core";
import { ReadRouting } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

const PrimaryLive = TestSql.layer("organization_DecisionReads_primary");
const ReplicaLive = TestSql.layer("organization_DecisionReads_replica");

const MigratedPrimary = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
  Layer.provide(PrimaryLive),
);

// The primary-backed records service, with a replica configured beside it.
const PrimaryWithReplica = MembershipRecords.layerSql.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(ReadRouting.replica(ReplicaLive)),
  Layer.provideMerge(PrimaryLive),
  Layer.provideMerge(MigratedPrimary),
);

const orgId = "org-1";
const member = Users.UserId("user-a");

describe("organization decision reads stay on the primary (RRC-003)", () => {
  it.effect("a removed member is Unrelated on the very next read even though the replica still lists them", () =>
    Effect.gen(function* () {
      const primary = yield* MembershipRecords.MembershipRecords;
      const replicaClient = yield* ReadRouting.ReplicaSqlClient;
      if (Option.isNone(replicaClient)) return assert.fail("the replica client was not configured");

      // The replica: same schema, and a copy of the membership that replication has not yet removed.
      // `Layer.fresh`: the memo map of the surrounding build would otherwise hand back the
      // primary-bound service for the same `layerSql` reference.
      const staleRecords = yield* Layer.build(
        Layer.fresh(MembershipRecords.layerSql).pipe(
          Layer.provide(NodeCrypto.layer),
          Layer.provide(Layer.succeed(SqlClient.SqlClient, replicaClient.value)),
        ),
      ).pipe(Effect.map((context) => Context.get(context, MembershipRecords.MembershipRecords)));
      yield* Migrations.run(Organization.Organization.migrations).pipe(
        Effect.provideService(SqlClient.SqlClient, replicaClient.value),
      );
      yield* staleRecords.create({ userId: member, organizationId: orgId, role: ["owner"] });

      yield* primary.create({ userId: member, organizationId: orgId, role: ["owner"] });
      yield* primary.remove(member, orgId);

      // Sanity: the replica really is stale.
      assert.isTrue(Option.isSome(yield* staleRecords.findByUserAndOrg(member, orgId)));
      // The decision read: the primary, so the removal is visible immediately.
      assert.isTrue(Option.isNone(yield* primary.findByUserAndOrg(member, orgId)));
    }).pipe(Effect.scoped, Effect.provide(PrimaryWithReplica)),
  );

  // The classification is structural: none of the records modules a decision reads through may
  // route a read (they take no `ReadOptions`, import no `ReadRouting`). Wiring one through it
  // would let a stale replica keep a removed member `Related`.
  it("no organization records module a decision reads through uses ReadRouting", () => {
    for (const module of [
      "MembershipRecords.ts",
      "TeamRecords.ts",
      "OrgRoleRecords.ts",
      "ActiveContextRecords.ts",
    ]) {
      const text = readFileSync(new URL(`../src/${module}`, import.meta.url), "utf8");
      assert.notMatch(text, /import[^;]*ReadRouting|ReadOptions|forRead|consistency:/, module);
    }
  });
});
