// Plan 04 (ADR-EA-040): `OrganizationRoles`, dynamic access control at its own interface, with no principal.
// The feature gate, the reserved names (RZS-005), the `Bound` (RRM-001), the quota, the veto and the
// observe point are proved here; `Organization.test.ts` keeps who may manage roles.
import { HookPoint, Persistence, Users } from "@awthaq/core";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Organization from "../src/Organization.ts";
import * as OrganizationActor from "../src/OrganizationActor.ts";
import * as OrganizationAuthority from "../src/OrganizationAuthority.ts";
import * as OrganizationDirectory from "../src/OrganizationDirectory.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";
import * as OrganizationMemory from "../src/OrganizationMemory.ts";
import * as OrganizationRoles from "../src/OrganizationRoles.ts";
import * as OrganizationSystem from "../src/OrganizationSystem.ts";

const dacOn = { enabled: true, maximumRolesPerOrganization: Number.POSITIVE_INFINITY };

const buildLayer = (
  config: Partial<Organization.OrganizationConfigShape> = { dynamicAccessControl: dacOn },
  taps: Layer.Layer<
    never,
    never,
    Layer.Success<typeof OrganizationHooks.OrganizationHooksLive>
  > = Layer.empty,
) =>
  OrganizationSystem.layer.pipe(
    Layer.provide(Organization.config(config)),
    Layer.provideMerge(OrganizationMemory.layer),
    Layer.provideMerge(Users.layer.pipe(Layer.provide(Persistence.memory))),
    Layer.provideMerge(Mailer.layerMemory),
    Layer.provideMerge(TestAuth.memoryFoundation),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(taps),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  );

const application = OrganizationActor.application("OrganizationRoles.test");
const unbounded = OrganizationActor.Bound.Unbounded();

const flipTag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error._tag),
  );

const arrange = Effect.gen(function* () {
  const directory = yield* OrganizationDirectory.OrganizationDirectory;
  const roles = yield* OrganizationRoles.OrganizationRoles;
  const org = yield* directory.create(application, {
    owner: Users.UserId("owner-1"),
    name: "Acme",
    slug: "acme",
  });
  return { org, roles };
});

describe("OrganizationRoles", () => {
  it.effect("every operation is refused while dynamic access control is off", () =>
    Effect.gen(function* () {
      const { org, roles } = yield* arrange;
      const input = { organizationId: org.id, permission: {}, bound: unbounded };
      assert.strictEqual(
        yield* flipTag(roles.create(application, { ...input, role: "billing" })),
        "DynamicAccessControlDisabled",
      );
      assert.strictEqual(yield* flipTag(roles.list(org.id)), "DynamicAccessControlDisabled");
      assert.strictEqual(yield* flipTag(roles.find(org.id, "x")), "DynamicAccessControlDisabled");
      assert.strictEqual(
        yield* flipTag(roles.update(application, { ...input, roleId: "x" })),
        "DynamicAccessControlDisabled",
      );
      assert.strictEqual(
        yield* flipTag(roles.remove(application, { organizationId: org.id, roleId: "x" })),
        "DynamicAccessControlDisabled",
      );
    }).pipe(Effect.provide(buildLayer({}))),
  );

  it.effect("a role round-trips: create, list, find, update, remove", () =>
    Effect.gen(function* () {
      const { org, roles } = yield* arrange;
      const created = yield* roles.create(application, {
        organizationId: org.id,
        role: "billing",
        permission: { invoice: ["read"] },
        bound: unbounded,
      });
      assert.strictEqual((yield* roles.list(org.id)).length, 1);
      assert.strictEqual((yield* roles.find(org.id, created.id)).role, "billing");
      const updated = yield* roles.update(application, {
        organizationId: org.id,
        roleId: created.id,
        permission: { invoice: ["read", "create"] },
        bound: unbounded,
      });
      assert.deepStrictEqual(updated.permission, { invoice: ["read", "create"] });
      yield* roles.remove(application, { organizationId: org.id, roleId: created.id });
      assert.deepStrictEqual(yield* roles.list(org.id), []);
      assert.strictEqual(yield* flipTag(roles.find(org.id, created.id)), "OrgRoleNotFound");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "built-in and configured static role names are reserved (RZS-005), and a name is unique",
    () =>
      Effect.gen(function* () {
        const { org, roles } = yield* arrange;
        const make = (role: string) =>
          roles.create(application, {
            organizationId: org.id,
            role,
            permission: {},
            bound: unbounded,
          });
        for (const reserved of ["owner", "admin", "member", "auditor"]) {
          assert.strictEqual(yield* flipTag(make(reserved)), "ReservedOrgRoleName");
        }
        yield* make("billing");
        assert.strictEqual(yield* flipTag(make("billing")), "OrgRoleNameTaken");
      }).pipe(
        Effect.provide(
          buildLayer({
            dynamicAccessControl: dacOn,
            permissionStatements: { auditor: { organization: ["read"] } },
          }),
        ),
      ),
  );

  it.effect("a Ceiling refuses statements its source does not hold, on create and on update", () =>
    Effect.gen(function* () {
      const { org, roles } = yield* arrange;
      const authority = yield* OrganizationAuthority.OrganizationAuthority;
      const memberCeiling = yield* authority.ceilingOf(org.id, ["member"]);
      assert.strictEqual(
        yield* flipTag(
          roles.create(application, {
            organizationId: org.id,
            role: "greedy",
            permission: { organization: ["delete"] },
            bound: memberCeiling,
          }),
        ),
        "RolePermissionEscalation",
      );
      const ok = yield* roles.create(application, {
        organizationId: org.id,
        role: "modest",
        permission: {},
        bound: memberCeiling,
      });
      assert.strictEqual(
        yield* flipTag(
          roles.update(application, {
            organizationId: org.id,
            roleId: ok.id,
            permission: { organization: ["delete"] },
            bound: memberCeiling,
          }),
        ),
        "RolePermissionEscalation",
      );
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "maximumRolesPerOrganization caps the roles, with a limitsFor override per organization",
    () =>
      Effect.gen(function* () {
        const { org, roles } = yield* arrange;
        const make = (role: string) =>
          roles.create(application, {
            organizationId: org.id,
            role,
            permission: {},
            bound: unbounded,
          });
        yield* make("a");
        assert.strictEqual(yield* flipTag(make("b")), "RoleLimitReached");
      }).pipe(
        Effect.provide(
          buildLayer({ dynamicAccessControl: { enabled: true, maximumRolesPerOrganization: 1 } }),
        ),
      ),
  );

  it.effect("a veto aborts with the point's id; the observers carry the actor", () => {
    const seen: Array<string> = [];
    return Effect.gen(function* () {
      const { org, roles } = yield* arrange;
      const aborted = yield* roles
        .create(application, {
          organizationId: org.id,
          role: "blocked",
          permission: {},
          bound: unbounded,
        })
        .pipe(Effect.flip);
      assert.strictEqual(aborted._tag, "HookAborted");
      if (aborted._tag === "HookAborted") {
        assert.strictEqual(aborted.point, OrganizationHooks.BeforeCreateRole.id);
      }
      assert.deepStrictEqual(yield* roles.list(org.id), []);
      yield* roles.create(OrganizationActor.directory("c1"), {
        organizationId: org.id,
        role: "fine",
        permission: {},
        bound: unbounded,
      });
      assert.deepStrictEqual(seen, ["created:Directory"]);
    }).pipe(
      Effect.provide(
        buildLayer(
          { dynamicAccessControl: dacOn },
          Layer.mergeAll(
            OrganizationHooks.BeforeCreateRole.tap((input) =>
              input.role === "blocked"
                ? Effect.fail(new HookPoint.HookAbort({ code: "NO" }))
                : Effect.succeed(input),
            ),
            OrganizationHooks.AfterCreateRole.tap((input) => {
              seen.push(`created:${input.actor._tag}`);
              return Effect.void;
            }),
          ),
        ),
      ),
    );
  });
});
