// BEH-EA-307: `checkRoleCeiling` and `syncMemberRoles`, RRM-001's `canGrant` rule with a role ceiling standing in for the
// caller. A source with no caller (an identity provider's role mapping) can confer only what its ceiling holds, never
// reshapes a member who out-privileges it, and never demotes the last owner.
import { Api } from "@awthaq/api";
import { Sessions, Users } from "@awthaq/core";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";
import * as OrganizationMemory from "../src/OrganizationMemory.ts";

const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
  Layer.provideMerge(TestAuth.memoryFoundation),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("organization-test-csrf-secret-padded-to-thirty-two-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const TestLayer = Organization.Organization.layer.pipe(
  Layer.provide(Organization.config({})),
  Layer.provide(AuthenticationLive),
  Layer.provide(CsrfProtectionLive),
  Layer.provideMerge(OrganizationMemory.layer),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(Mailer.layerMemory),
  Layer.provideMerge(SqlTransaction.layerNoop),
  Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
);

const asCaller = (id: string) =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `${id}-session`,
  });

const setup = Effect.gen(function* () {
  const organization = yield* Organization.Organization;
  const org = yield* organization.create({
    caller: asCaller("owner-1"),
    name: "Acme",
    slug: "acme",
  });
  return { organization, organizationId: org.id };
});

const rolesOf = (userId: string, organizationId: string) =>
  Effect.flatMap(MembershipRecords.MembershipRecords, (members) =>
    members.findByUserAndOrg(Users.UserId(userId), organizationId),
  ).pipe(Effect.map((found) => Option.map(found, (row) => row.role)));

describe("Organization.checkRoleCeiling", () => {
  it.effect(
    "answers what a ceiling cannot confer, by the same canGrant rule as every grant path",
    () =>
      Effect.gen(function* () {
        const { organization, organizationId } = yield* setup;
        const check = (roles: ReadonlyArray<string>, ceiling: ReadonlyArray<string>) =>
          organization.checkRoleCeiling({ organizationId, roles, ceiling });
        assert.deepStrictEqual(yield* check(["member"], ["member"]), Option.none());
        assert.deepStrictEqual(yield* check(["member"], ["admin"]), Option.none());
        assert.deepStrictEqual(yield* check(["admin"], ["member"]), Option.some("exceedsCeiling"));
        // An admin ceiling cannot mint an owner: the guard is the statements held, not the name.
        assert.deepStrictEqual(yield* check(["owner"], ["admin"]), Option.some("exceedsCeiling"));
        assert.deepStrictEqual(yield* check(["owner"], ["owner"]), Option.none());
        assert.deepStrictEqual(yield* check(["nope"], ["owner"]), Option.some("unknownRole"));
        assert.deepStrictEqual(yield* check(["member"], ["nope"]), Option.some("unknownCeiling"));
        const missing = yield* organization
          .checkRoleCeiling({
            organizationId: "no-such-org",
            roles: ["member"],
            ceiling: ["member"],
          })
          .pipe(Effect.flip);
        assert.strictEqual(missing._tag, "OrganizationNotFound");
      }).pipe(Effect.provide(TestLayer)),
  );
});

describe("Organization.syncMemberRoles", () => {
  it.effect("adds a membership within the ceiling, and refuses one above it, adding nothing", () =>
    Effect.gen(function* () {
      const { organization, organizationId } = yield* setup;
      const added = yield* organization.syncMemberRoles({
        organizationId,
        userId: Users.UserId("idp-user"),
        roles: ["member"],
        ceiling: ["member"],
      });
      assert.strictEqual(added.change, "added");
      assert.deepStrictEqual(yield* rolesOf("idp-user", organizationId), Option.some(["member"]));
      const refused = yield* organization
        .syncMemberRoles({
          organizationId,
          userId: Users.UserId("greedy"),
          roles: ["owner"],
          ceiling: ["member"],
        })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "RolePermissionEscalation");
      assert.deepStrictEqual(yield* rolesOf("greedy", organizationId), Option.none());
      const unknown = yield* organization
        .syncMemberRoles({
          organizationId,
          userId: Users.UserId("greedy"),
          roles: ["wizard"],
          ceiling: ["owner"],
        })
        .pipe(Effect.flip);
      assert.strictEqual(unknown._tag, "UnknownOrgRole");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("re-roles an existing member within the ceiling, and reports an unchanged set", () =>
    Effect.gen(function* () {
      const { organization, organizationId } = yield* setup;
      const userId = Users.UserId("idp-user");
      yield* organization.syncMemberRoles({
        organizationId,
        userId,
        roles: ["member"],
        ceiling: ["admin"],
      });
      const promoted = yield* organization.syncMemberRoles({
        organizationId,
        userId,
        roles: ["admin"],
        ceiling: ["admin"],
      });
      assert.strictEqual(promoted.change, "updated");
      assert.deepStrictEqual(yield* rolesOf("idp-user", organizationId), Option.some(["admin"]));
      const same = yield* organization.syncMemberRoles({
        organizationId,
        userId,
        roles: ["admin"],
        ceiling: ["admin"],
      });
      assert.strictEqual(same.change, "unchanged");
      const demoted = yield* organization.syncMemberRoles({
        organizationId,
        userId,
        roles: ["member"],
        ceiling: ["admin"],
      });
      assert.strictEqual(demoted.change, "updated");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "never reshapes a member who out-privileges the source, nor demotes the last owner",
    () =>
      Effect.gen(function* () {
        const { organization, organizationId } = yield* setup;
        // The creator is the organization's only owner; a member-ceiling source cannot touch them at all...
        const outranked = yield* organization
          .syncMemberRoles({
            organizationId,
            userId: Users.UserId("owner-1"),
            roles: ["member"],
            ceiling: ["member"],
          })
          .pipe(Effect.flip);
        assert.strictEqual(outranked._tag, "RolePermissionEscalation");
        assert.deepStrictEqual(yield* rolesOf("owner-1", organizationId), Option.some(["owner"]));
        // ...and even an owner-ceiling source cannot demote the LAST owner.
        const last = yield* organization
          .syncMemberRoles({
            organizationId,
            userId: Users.UserId("owner-1"),
            roles: ["member"],
            ceiling: ["owner"],
          })
          .pipe(Effect.flip);
        assert.strictEqual(last._tag, "OwnerInvariantViolation");
        assert.deepStrictEqual(yield* rolesOf("owner-1", organizationId), Option.some(["owner"]));
      }).pipe(Effect.provide(TestLayer)),
  );
});
