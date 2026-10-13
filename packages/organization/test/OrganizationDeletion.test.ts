// Plan 04 (F7, ADR-EA-040): the organization-deletion registry. Another plugin's rows that hang off an
// organization (connections) are removed in the deletion's own transaction, in `order` then id order, and
// their `afterCommit` runs only once the deletion has committed.
import { Migrations, Persistence, Users } from "@awthaq/core";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";
import * as InvitationRecords from "../src/InvitationRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationActor from "../src/OrganizationActor.ts";
import * as OrganizationDeletion from "../src/OrganizationDeletion.ts";
import * as OrganizationDirectory from "../src/OrganizationDirectory.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";
import * as OrganizationMemory from "../src/OrganizationMemory.ts";
import * as OrganizationRecords from "../src/OrganizationRecords.ts";
import * as OrganizationSystem from "../src/OrganizationSystem.ts";
import * as OrgRoleRecords from "../src/OrgRoleRecords.ts";
import * as TeamRecords from "../src/TeamRecords.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

const application = OrganizationActor.application("OrganizationDeletion.test");

const base = OrganizationSystem.layer.pipe(
  Layer.provide(Organization.config({})),
  Layer.provideMerge(OrganizationMemory.layer),
  Layer.provideMerge(
    Layer.mergeAll(Users.layer.pipe(Layer.provide(Persistence.memory)), Mailer.layerMemory),
  ),
  Layer.provideMerge(TestAuth.memoryFoundation),
  Layer.provideMerge(SqlTransaction.layerNoop),
  Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
);

const handler = (log: Array<string>, name: string) => ({
  inTransaction: (organizationId: string) =>
    Effect.sync(() => {
      log.push(`in:${name}:${organizationId}`);
    }),
  afterCommit: (organizationId: string) =>
    Effect.sync(() => {
      log.push(`after:${name}:${organizationId}`);
    }),
});

const contribution = (log: Array<string>, id: string, order?: number) =>
  OrganizationDeletion.contribute({ id, order, make: Effect.succeed(handler(log, id)) });

const make = Effect.flatMap(OrganizationDirectory.OrganizationDirectory, (directory) =>
  directory.create(application, { owner: Users.UserId("o"), name: "A", slug: "a" }),
);

describe("OrganizationDeletion", () => {
  it.effect(
    "runs contributions by order then id, inside the deletion, and afterCommit once it ends",
    () => {
      const log: Array<string> = [];
      return Effect.gen(function* () {
        const directory = yield* OrganizationDirectory.OrganizationDirectory;
        const org = yield* make;
        yield* directory.delete(application, { organizationId: org.id });
        assert.deepStrictEqual(log, [
          `in:b:${org.id}`,
          `in:a:${org.id}`,
          `in:c:${org.id}`,
          `after:b:${org.id}`,
          `after:a:${org.id}`,
          `after:c:${org.id}`,
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            contribution(log, "c", 5),
            contribution(log, "a", 1),
            contribution(log, "b", 0),
          ).pipe(Layer.provideMerge(base)),
        ),
      );
    },
  );

  it.effect("the first read freezes the registry: a late contribution is a defect", () =>
    Effect.gen(function* () {
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const registry = yield* OrganizationDeletion.OrganizationDeletion;
      const org = yield* make;
      yield* directory.delete(application, { organizationId: org.id });
      const exit = yield* Effect.exit(
        registry.register({ id: "late", handler: handler([], "late") }),
      );
      assert.isTrue(Exit.isFailure(exit) && Exit.hasDies(exit));
    }).pipe(Effect.provide(base)),
  );

  it.effect("a deletion with no contributions still deletes", () =>
    Effect.gen(function* () {
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const org = yield* make;
      yield* directory.delete(application, { organizationId: org.id });
      assert.isTrue(Option.isNone(yield* directory.find(org.id)));
    }).pipe(Effect.provide(base)),
  );
});

// ---- over SQL: a failing contribution rolls the whole deletion back ---------------------------------

const SqlLive = TestSql.layer("organization_OrganizationDeletion");
const Migrated = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
  Layer.provide(SqlLive),
);
const sqlRecords = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(Layer.provide(NodeCrypto.layer));

describe("OrganizationDeletion over SQL", () => {
  it.effect("a contribution that fails rolls the deletion back and runs no afterCommit", () => {
    const log: Array<string> = [];
    const failing = OrganizationDeletion.contribute({
      id: "failing",
      order: 10,
      make: Effect.succeed({
        inTransaction: () => Effect.die(new Error("a connection store is down")),
        afterCommit: () =>
          Effect.sync(() => {
            log.push("after:failing");
          }),
      }),
    });
    return Effect.gen(function* () {
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const members = yield* MembershipRecords.MembershipRecords;
      const org = yield* make;
      const exit = yield* Effect.exit(directory.delete(application, { organizationId: org.id }));
      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(Option.isSome(yield* directory.find(org.id)));
      assert.isTrue(Option.isSome(yield* members.findByUserAndOrg(Users.UserId("o"), org.id)));
      assert.deepStrictEqual(log, []);
    }).pipe(
      Effect.provide(
        failing.pipe(
          Layer.provideMerge(
            OrganizationSystem.layer.pipe(
              Layer.provide(Organization.config({})),
              Layer.provideMerge(
                Layer.mergeAll(
                  Users.layer.pipe(Layer.provide(Persistence.memory)),
                  Mailer.layerMemory,
                ),
              ),
              Layer.provideMerge(TestAuth.memoryFoundation),
              Layer.provideMerge(sqlRecords(OrganizationRecords.layerSql)),
              Layer.provideMerge(sqlRecords(MembershipRecords.layerSql)),
              Layer.provideMerge(ActiveContextRecords.layerSql),
              Layer.provideMerge(sqlRecords(InvitationRecords.layerSql)),
              Layer.provideMerge(sqlRecords(OrgRoleRecords.layerSql)),
              Layer.provideMerge(sqlRecords(TeamRecords.layerSql)),
              Layer.provideMerge(SqlTransaction.layerSql),
              Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
              Layer.provideMerge(Migrated),
              Layer.provideMerge(SqlLive),
            ),
          ),
        ),
      ),
    );
  });
});
