// Plan 04 (ADR-EA-040): `OrganizationDirectory`, tested at its own interface, with no principal. The
// organization row's lifecycle: creating one atomically with its creator's membership, updating, deleting
// with its cascade, and a platform suspension that runs a veto and an observe point (BEH-EA-237).
import { HookPoint, Migrations, Users } from "@awthaq/core";
import { SqlTransaction } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";
import * as InvitationRecords from "../src/InvitationRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationActor from "../src/OrganizationActor.ts";
import * as OrganizationDirectory from "../src/OrganizationDirectory.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";
import * as OrganizationMemory from "../src/OrganizationMemory.ts";
import * as OrganizationRecords from "../src/OrganizationRecords.ts";
import * as OrganizationSystem from "../src/OrganizationSystem.ts";
import * as OrgRoleRecords from "../src/OrgRoleRecords.ts";
import * as TeamRecords from "../src/TeamRecords.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

const buildLayer = (
  config: Partial<Organization.OrganizationConfigShape> = {},
  taps: Layer.Layer<
    never,
    never,
    Layer.Success<typeof OrganizationHooks.OrganizationHooksLive>
  > = Layer.empty,
) =>
  OrganizationSystem.layer.pipe(
    Layer.provide(Organization.config(config)),
    Layer.provideMerge(OrganizationMemory.layer),
    Layer.provideMerge(TestAuth.memoryFoundation),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(taps),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  );

const application = OrganizationActor.application("OrganizationDirectory.test");
const admin = OrganizationActor.platformAdmin(Users.UserId("admin-1"));
const owner = Users.UserId("owner-1");

const flipTag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error._tag),
  );

const make = (slug = "acme", ownerId: Users.UserId = owner) =>
  Effect.flatMap(OrganizationDirectory.OrganizationDirectory, (directory) =>
    directory.create(application, { owner: ownerId, name: "Acme", slug }),
  );

describe("OrganizationDirectory.create", () => {
  it.effect(
    "makes the creator the owner (or the configured creatorRole), and refuses a taken slug",
    () =>
      Effect.gen(function* () {
        const directory = yield* OrganizationDirectory.OrganizationDirectory;
        const members = yield* MembershipRecords.MembershipRecords;
        const org = yield* make();
        const membership = Option.getOrThrow(yield* members.findByUserAndOrg(owner, org.id));
        assert.deepStrictEqual(membership.role, ["admin"]);
        assert.strictEqual(
          yield* flipTag(directory.create(application, { owner, name: "Dup", slug: "acme" })),
          "OrganizationSlugTaken",
        );
        assert.isFalse(yield* directory.isSlugAvailable("acme"));
        assert.isTrue(yield* directory.isSlugAvailable("free"));
      }).pipe(Effect.provide(buildLayer({ creatorRole: "admin" }))),
  );

  it.effect(
    "organizationLimit counts the organizations the owner holds creatorRole in, even when it is not owner",
    () =>
      Effect.gen(function* () {
        const directory = yield* OrganizationDirectory.OrganizationDirectory;
        yield* make("one");
        assert.strictEqual(
          yield* flipTag(directory.create(application, { owner, name: "Two", slug: "two" })),
          "OrganizationLimitReached",
        );
        // Another owner is unaffected.
        yield* make("three", Users.UserId("owner-2"));
      }).pipe(Effect.provide(buildLayer({ creatorRole: "admin", organizationLimit: 1 }))),
  );

  it.effect("only a configured region is accepted (DRS-007)", () =>
    Effect.gen(function* () {
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      assert.strictEqual(
        yield* flipTag(
          directory.create(application, { owner, name: "A", slug: "a", homeRegion: "mars" }),
        ),
        "UnknownRegion",
      );
      yield* directory.create(application, { owner, name: "A", slug: "a", homeRegion: "eu-west" });
    }).pipe(Effect.provide(buildLayer({ regions: ["eu-west"] }))),
  );

  it.effect(
    "a veto aborts with the point's id and writes nothing; the observers carry the actor, D7 included",
    () => {
      const seen: Array<string> = [];
      return Effect.gen(function* () {
        const directory = yield* OrganizationDirectory.OrganizationDirectory;
        const aborted = yield* directory
          .create(application, { owner, name: "Nope", slug: "nope" })
          .pipe(Effect.flip);
        assert.strictEqual(aborted._tag, "HookAborted");
        if (aborted._tag === "HookAborted") {
          assert.strictEqual(aborted.point, OrganizationHooks.BeforeCreateOrganization.id);
        }
        assert.isTrue(yield* directory.isSlugAvailable("nope"));
        yield* directory.create(OrganizationActor.directory("c1"), {
          owner,
          name: "Ok",
          slug: "ok",
        });
        assert.deepStrictEqual(seen, ["created:Directory", "memberAdded:Directory"]);
      }).pipe(
        Effect.provide(
          buildLayer(
            {},
            Layer.mergeAll(
              OrganizationHooks.BeforeCreateOrganization.tap((input) =>
                input.slug === "nope"
                  ? Effect.fail(new HookPoint.HookAbort({ code: "NO" }))
                  : Effect.succeed(input),
              ),
              OrganizationHooks.AfterCreateOrganization.tap((input) => {
                seen.push(`created:${input.actor._tag}`);
                return Effect.void;
              }),
              OrganizationHooks.AfterAddMember.tap((input) => {
                seen.push(`memberAdded:${input.actor._tag}`);
                return Effect.void;
              }),
            ),
          ),
        ),
      );
    },
  );
});

describe("OrganizationDirectory.update and delete", () => {
  it.effect(
    "update changes the row, refuses a taken slug, and a suspended organization is not found",
    () =>
      Effect.gen(function* () {
        const directory = yield* OrganizationDirectory.OrganizationDirectory;
        const org = yield* make("acme");
        yield* make("other", Users.UserId("owner-2"));
        const renamed = yield* directory.update(application, {
          organizationId: org.id,
          name: "Renamed",
        });
        assert.strictEqual(renamed.name, "Renamed");
        assert.strictEqual(
          yield* flipTag(directory.update(application, { organizationId: org.id, slug: "other" })),
          "OrganizationSlugTaken",
        );
        yield* directory.suspend(admin, { organizationId: org.id });
        assert.strictEqual(
          yield* flipTag(directory.update(application, { organizationId: org.id, name: "x" })),
          "OrganizationNotFound",
        );
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("delete is refused when configured off", () =>
    Effect.gen(function* () {
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const org = yield* make();
      assert.strictEqual(
        yield* flipTag(directory.delete(application, { organizationId: org.id })),
        "OrganizationDeletionDisabled",
      );
    }).pipe(Effect.provide(buildLayer({ disableOrganizationDeletion: true }))),
  );

  it.effect("delete removes members, invitations, teams, roles and the active pointer", () =>
    Effect.gen(function* () {
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const members = yield* MembershipRecords.MembershipRecords;
      const teams = yield* TeamRecords.TeamRecords;
      const roles = yield* OrgRoleRecords.OrgRoleRecords;
      const activeContext = yield* ActiveContextRecords.ActiveContextRecords;
      const org = yield* make();
      yield* teams.createTeam({ organizationId: org.id, name: "Eng" });
      yield* roles.create({ organizationId: org.id, role: "billing", permission: {} });
      const membership = Option.getOrThrow(yield* members.findByUserAndOrg(owner, org.id));
      yield* activeContext.setOrganization("s1", membership);
      yield* directory.delete(application, { organizationId: org.id });
      assert.isTrue(Option.isNone(yield* directory.find(org.id)));
      assert.deepStrictEqual(yield* teams.listTeamsByOrganization(org.id), []);
      assert.deepStrictEqual(yield* roles.listByOrganization(org.id), []);
      assert.isTrue(
        Option.isNone(
          Option.getOrThrow(yield* activeContext.findBySessionId("s1")).activeOrganizationId,
        ),
      );
    }).pipe(Effect.provide(buildLayer())),
  );
});

describe("OrganizationDirectory.suspend and reinstate (BEH-EA-237)", () => {
  it.effect("find sees a suspended organization, findActive and requireActive do not", () =>
    Effect.gen(function* () {
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const org = yield* make();
      yield* directory.suspend(admin, { organizationId: org.id });
      assert.isTrue(Option.isSome(yield* directory.find(org.id)));
      assert.isTrue(Option.isNone(yield* directory.findActive(org.id)));
      assert.strictEqual(yield* flipTag(directory.requireActive(org.id)), "OrganizationNotFound");
      yield* directory.reinstate(admin, { organizationId: org.id });
      assert.isTrue(Option.isSome(yield* directory.findActive(org.id)));
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("is idempotent: the first suspendedAt is kept, and an unknown id is not found", () =>
    Effect.gen(function* () {
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const org = yield* make();
      const first = yield* directory.suspend(admin, { organizationId: org.id, reason: " fraud " });
      const second = yield* directory.suspend(admin, { organizationId: org.id });
      assert.deepStrictEqual(second.suspendedAt, first.suspendedAt);
      assert.strictEqual(
        yield* flipTag(directory.suspend(admin, { organizationId: "nope" })),
        "OrganizationNotFound",
      );
      assert.strictEqual(
        yield* flipTag(directory.reinstate(admin, { organizationId: "nope" })),
        "OrganizationNotFound",
      );
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "a veto aborts the suspension and leaves the organization active; the observer names the admin",
    () => {
      const seen: Array<string> = [];
      return Effect.gen(function* () {
        const directory = yield* OrganizationDirectory.OrganizationDirectory;
        const org = yield* make();
        const refused = yield* directory
          .suspend(admin, { organizationId: org.id, reason: "block" })
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "HookAborted");
        assert.isTrue(Option.isSome(yield* directory.findActive(org.id)));
        yield* directory.suspend(admin, { organizationId: org.id, reason: "ok" });
        yield* directory.reinstate(admin, { organizationId: org.id });
        assert.deepStrictEqual(seen, ["suspended:PlatformAdmin:ok", "reinstated:PlatformAdmin"]);
      }).pipe(
        Effect.provide(
          buildLayer(
            {},
            Layer.mergeAll(
              OrganizationHooks.BeforeSuspendOrganization.tap((input) =>
                input.reason === "block"
                  ? Effect.fail(new HookPoint.HookAbort({ code: "NO" }))
                  : Effect.succeed(input),
              ),
              OrganizationHooks.AfterSuspendOrganization.tap((input) => {
                seen.push(`suspended:${input.actor._tag}:${input.reason}`);
                return Effect.void;
              }),
              OrganizationHooks.AfterReinstateOrganization.tap((input) => {
                seen.push(`reinstated:${input.actor._tag}`);
                return Effect.void;
              }),
            ),
          ),
        ),
      );
    },
  );

  it("only a platform administrator can be the actor (a compile-time rule)", () => {
    const call = (directory: OrganizationDirectory.OrganizationDirectoryShape) =>
      // @ts-expect-error an `Application` actor is not a `PlatformAdminActor`
      directory.suspend(application, { organizationId: "x" });
    assert.isFunction(call);
  });
});

// ---- over SQL: the organization and its creator's membership are one transaction ---------------------

const SqlLive = TestSql.layer("organization_OrganizationDirectory");
const Migrated = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
  Layer.provide(SqlLive),
);
const sqlRecords = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(Layer.provide(NodeCrypto.layer));
const SqlSystemLive = OrganizationSystem.layer.pipe(
  Layer.provide(Organization.config({})),
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
);

const countRows = (sql: SqlClient.SqlClient, table: string) =>
  sql.unsafe(`SELECT COUNT(*) AS n FROM ${table}`).pipe(
    Effect.map((rows) => {
      const first = rows[0];
      return typeof first === "object" && first !== null && "n" in first ? Number(first.n) : -1;
    }),
  );

describe("OrganizationDirectory over SQL", () => {
  it.effect("a failing membership insert leaves no organization behind (D3)", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* TestSql.injectFailure({
        name: "fail_membership_insert",
        table: "organization_membership",
        event: "INSERT",
      });
      const exit = yield* Effect.exit(make());
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(yield* countRows(sql, "organization_org"), 0);
      assert.strictEqual(yield* countRows(sql, "organization_membership"), 0);
    }).pipe(Effect.provide(SqlSystemLive)),
  );

  it.effect("delete rolls the whole cascade back when the final organization delete fails", () =>
    Effect.gen(function* () {
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const teams = yield* TeamRecords.TeamRecords;
      const sql = yield* SqlClient.SqlClient;
      const org = yield* make();
      yield* teams.createTeam({ organizationId: org.id, name: "Eng" });
      yield* TestSql.injectFailure({
        name: "fail_org_delete",
        table: "organization_org",
        event: "DELETE",
      });
      const exit = yield* Effect.exit(directory.delete(application, { organizationId: org.id }));
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(yield* countRows(sql, "organization_membership"), 1);
      assert.strictEqual(yield* countRows(sql, "organization_team"), 1);
      assert.strictEqual(yield* countRows(sql, "organization_org"), 1);
    }).pipe(Effect.provide(SqlSystemLive)),
  );
});
