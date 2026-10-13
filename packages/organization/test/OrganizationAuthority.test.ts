// Plan 04 (ADR-EA-040): `OrganizationAuthority`, the read-only evaluation path. The plugin's own
// gating, the `Bound` a role-conferring operation derives, and `OrganizationQadi` all read it, so
// they cannot disagree (ADR-EA-009). No principal, no write, no hook point appears here.
import { Persistence, Users } from "@awthaq/core";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationActor from "../src/OrganizationActor.ts";
import * as OrganizationAuthority from "../src/OrganizationAuthority.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";
import * as OrganizationMemory from "../src/OrganizationMemory.ts";
import * as OrganizationRecords from "../src/OrganizationRecords.ts";
import * as OrganizationSystem from "../src/OrganizationSystem.ts";
import * as OrganizationTeams from "../src/OrganizationTeams.ts";
import * as OrgRoleRecords from "../src/OrgRoleRecords.ts";
import * as PermissionEngine from "../src/PermissionEngine.ts";
import * as TeamRecords from "../src/TeamRecords.ts";
import { grant } from "./support.ts";

const buildLayer = (config: Partial<Organization.OrganizationConfigShape> = {}) =>
  OrganizationSystem.layer.pipe(
    Layer.provide(Organization.config(config)),
    Layer.provideMerge(OrganizationMemory.layer),
    Layer.provideMerge(
      Layer.mergeAll(Users.layer.pipe(Layer.provide(Persistence.memory)), Mailer.layerMemory),
    ),
    Layer.provideMerge(TestAuth.memoryFoundation),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  );

const userId = Users.UserId;

const arrange = Effect.gen(function* () {
  const orgs = yield* OrganizationRecords.OrganizationRecords;
  const members = yield* MembershipRecords.MembershipRecords;
  const authority = yield* OrganizationAuthority.OrganizationAuthority;
  const org = yield* orgs.create({ name: "Acme", slug: "acme" });
  const join = (id: string, role: ReadonlyArray<string>) =>
    members.create({ userId: userId(id), organizationId: org.id, role });
  return { org, orgs, authority, join };
});

describe("OrganizationAuthority", () => {
  it.effect(
    "statementsByRole is the static roles, plus the live dynamic ones only when enabled",
    () =>
      Effect.gen(function* () {
        const { org, authority } = yield* arrange;
        const roles = yield* OrgRoleRecords.OrgRoleRecords;
        yield* roles.create({
          organizationId: org.id,
          role: "billing",
          permission: { invoice: ["read"] },
        });
        const withDynamic = yield* authority.statementsByRole(org.id);
        assert.deepStrictEqual([...withDynamic.keys()].sort(), [
          "admin",
          "billing",
          "member",
          "owner",
        ]);
      }).pipe(
        Effect.provide(
          buildLayer({ dynamicAccessControl: { enabled: true, maximumRolesPerOrganization: 5 } }),
        ),
      ),
  );

  it.effect("a dynamic role is invisible while dynamic access control is off", () =>
    Effect.gen(function* () {
      const { org, authority } = yield* arrange;
      const roles = yield* OrgRoleRecords.OrgRoleRecords;
      yield* roles.create({
        organizationId: org.id,
        role: "billing",
        permission: { invoice: ["read"] },
      });
      const without = yield* authority.statementsByRole(org.id);
      assert.isFalse(without.has("billing"));
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("effectivePermissions is what the membership's roles confer", () =>
    Effect.gen(function* () {
      const { org, authority, join } = yield* arrange;
      const admin = yield* join("a", ["admin"]);
      const member = yield* join("m", ["member"]);
      const adminStatements = yield* authority.effectivePermissions(org.id, admin);
      const memberStatements = yield* authority.effectivePermissions(org.id, member);
      assert.isTrue(PermissionEngine.hasPermission(adminStatements, "member", "update"));
      assert.isFalse(PermissionEngine.hasPermission(memberStatements, "member", "update"));
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "attributesFor answers None for a non-member and the role and statements for a member",
    () =>
      Effect.gen(function* () {
        const { org, authority, join } = yield* arrange;
        yield* join("a", ["admin"]);
        assert.isTrue(Option.isNone(yield* authority.attributesFor(org.id, userId("stranger"))));
        const attrs = Option.getOrThrow(yield* authority.attributesFor(org.id, userId("a")));
        assert.deepStrictEqual(attrs.role, ["admin"]);
        assert.isTrue(PermissionEngine.hasPermission(attrs.permissions, "team", "create"));
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("team authority flows down the subtree, never up or sideways (OHS-004)", () =>
    Effect.gen(function* () {
      const { org, authority, join } = yield* arrange;
      const teams = yield* OrganizationTeams.OrganizationTeams;
      const records = yield* TeamRecords.TeamRecords;
      yield* join("lead", ["member"]);
      const actor = OrganizationActor.application("test");
      const make = (name: string, parentId?: string) =>
        teams
          .create(actor, { organizationId: org.id, name, parentId })
          .pipe(Effect.map((created) => created.team));
      const eng = yield* make("Eng");
      const platform = yield* make("Platform", eng.id);
      const sales = yield* make("Sales");
      yield* records.addTeamMember({ teamId: eng.id, userId: userId("lead"), role: ["lead"] });
      const canUpdate = (teamId: string) =>
        authority
          .teamAuthority(userId("lead"), org.id, teamId)
          .pipe(
            Effect.map((statements) =>
              PermissionEngine.hasPermission(statements, "team", "update"),
            ),
          );
      assert.isTrue(yield* canUpdate(eng.id));
      assert.isTrue(yield* canUpdate(platform.id));
      assert.isFalse(yield* canUpdate(sales.id));
    }).pipe(
      Effect.provide(
        buildLayer({
          teams: {
            enabled: true,
            maximumTeams: Infinity,
            maximumMembersPerTeam: Infinity,
            allowRemovingAllTeams: true,
          },
        }),
      ),
    ),
  );

  it.effect(
    "checkRoleCeiling reports unknownRole, unknownCeiling and exceedsCeiling, else None",
    () =>
      Effect.gen(function* () {
        const { org, authority } = yield* arrange;
        const check = (roles: ReadonlyArray<string>, ceiling: ReadonlyArray<string>) =>
          authority.checkRoleCeiling({ organizationId: org.id, roles, ceiling });
        assert.deepStrictEqual(yield* check(["nope"], ["admin"]), Option.some("unknownRole"));
        assert.deepStrictEqual(yield* check(["member"], ["nope"]), Option.some("unknownCeiling"));
        assert.deepStrictEqual(yield* check(["owner"], ["member"]), Option.some("exceedsCeiling"));
        assert.deepStrictEqual(yield* check(["member"], ["admin"]), Option.none());
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("checkRoleCeiling reads a suspended organization as not found", () =>
    Effect.gen(function* () {
      const { org, orgs, authority } = yield* arrange;
      yield* orgs.setSuspended(grant, org.id, Option.some(yield* DateTime.now));
      const failure = yield* authority
        .checkRoleCeiling({ organizationId: org.id, roles: ["member"], ceiling: ["admin"] })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "OrganizationNotFound");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "ceilingOf is a Ceiling of what the roles confer, and UnknownOrgRole for an unknown name",
    () =>
      Effect.gen(function* () {
        const { org, authority } = yield* arrange;
        const bound = yield* authority.ceilingOf(org.id, ["member"]);
        assert.strictEqual(bound._tag, "Ceiling");
        const failure = yield* authority.ceilingOf(org.id, ["nope"]).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "UnknownOrgRole");
      }).pipe(Effect.provide(buildLayer())),
  );
});
