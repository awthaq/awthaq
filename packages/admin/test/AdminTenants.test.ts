// EP-003 (ADR-EA-018, BEH-EA-232): the superadmin tenant-administration plugin,
// composed the way an application does — `Organization` beside `AdminTenants` —
// and driven domain-level, like `Admin.test.ts`.
import { Api } from "@awthaq/api";
import { AuditLog, AuthEvents, Hooks, Sessions, Users } from "@awthaq/core";
import {
  ActiveContextRecords,
  InvitationRecords,
  MembershipRecords,
  Organization,
  OrganizationHooks,
  OrganizationRecords,
  OrgRoleRecords,
  TeamRecords,
} from "@awthaq/organization";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Admin from "../src/Admin.ts";
import * as AdminTenants from "../src/AdminTenants.ts";

const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);
const AdminAuthenticationLive = Authentication.AdminAuthenticationLive.pipe(
  Layer.provide(AuthenticationLive),
);
const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("admin-tenants-test-csrf-secret-padded-to-thirty-two-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const buildLayer = (config: Partial<Admin.AdminConfigShape>) =>
  // `AdminTenants` `dependsOn: [Organization]`, so the type system makes the organization
  // plugin part of the composition: it must sit *under* `AdminTenants`, not beside it.
  AdminTenants.AdminTenants.layer.pipe(
    Layer.provideMerge(
      Organization.Organization.layer.pipe(
        Layer.provide(Organization.config({})),
        Layer.provide(AuthenticationLive),
      ),
    ),
    Layer.provide(Admin.config(config)),
    Layer.provide(AdminAuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(OrganizationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(MembershipRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(ActiveContextRecords.layerMemory),
    Layer.provideMerge(InvitationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(OrgRoleRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(TeamRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(Mailer.layerMemory),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  );

const asCaller = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `${id}-session`,
  });

const superadminOnly: Partial<Admin.AdminConfigShape> = {
  canAdministerTenants: ({ admin }) => Effect.succeed(admin.id === "superadmin-1"),
};

describe("AdminTenants (BEH-EA-232)", () => {
  it.effect("every operation is denied by default, and the denial is audited", () =>
    Effect.gen(function* () {
      const tenants = yield* AdminTenants.AdminTenants;
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const auditLog = yield* AuditLog.AuditLog;
      const caller = asCaller("admin-1");
      const results = yield* Effect.all([
        tenants.listOrganizations(caller).pipe(Effect.flip),
        tenants.getOrganization(caller, org.id).pipe(Effect.flip),
        tenants.suspendOrganization(caller, org.id, {}).pipe(Effect.flip),
        tenants.unsuspendOrganization(caller, org.id).pipe(Effect.flip),
      ]);
      assert.deepStrictEqual(
        results.map((failure) => failure._tag),
        Array(4).fill("AdminActionDenied"),
      );
      // Denied means untouched.
      const stillActive = yield* organization.get(owner, org.id);
      assert.strictEqual(stillActive.id, org.id);
      const denials = yield* auditLog.list({ eventTag: "auth.admin.actionDenied" });
      assert.strictEqual(denials.length, 4);
    }).pipe(Effect.provide(buildLayer({}))),
  );

  it.effect("a denied caller cannot tell whether an organization id exists", () =>
    Effect.gen(function* () {
      const tenants = yield* AdminTenants.AdminTenants;
      const caller = asCaller("admin-1");
      const unknown = yield* tenants.getOrganization(caller, "no-such-org").pipe(Effect.flip);
      assert.strictEqual(unknown._tag, "AdminActionDenied");
      const asSuperadmin = yield* tenants
        .getOrganization(asCaller("superadmin-1"), "no-such-org")
        .pipe(Effect.flip);
      assert.strictEqual(asSuperadmin._tag, "AdminOrganizationNotFound");
    }).pipe(Effect.provide(buildLayer(superadminOnly))),
  );

  it.effect("the superadmin lists organizations keyset-paginated and reads one", () =>
    Effect.gen(function* () {
      const tenants = yield* AdminTenants.AdminTenants;
      const organization = yield* Organization.Organization;
      const superadmin = asCaller("superadmin-1");
      for (const slug of ["a", "b", "c", "d", "e"]) {
        yield* organization.create({ caller: asCaller(`owner-${slug}`), name: slug, slug });
      }
      const first = yield* tenants.listOrganizations(superadmin, { limit: 2 });
      assert.strictEqual(first.items.length, 2);
      assert.isTrue(Option.isSome(first.nextCursor));
      const second = yield* tenants.listOrganizations(superadmin, {
        cursor: Option.getOrThrow(first.nextCursor),
        limit: 10,
      });
      assert.strictEqual(second.items.length, 3);
      assert.isTrue(Option.isNone(second.nextCursor));
      const one = yield* tenants.getOrganization(superadmin, second.items[0]?.id ?? "");
      assert.strictEqual(one.id, second.items[0]?.id);
    }).pipe(Effect.provide(buildLayer(superadminOnly))),
  );

  it.effect("a suspended organization refuses its members, and reinstating restores access", () =>
    Effect.gen(function* () {
      const tenants = yield* AdminTenants.AdminTenants;
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const superadmin = asCaller("superadmin-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });

      const suspended = yield* tenants.suspendOrganization(superadmin, org.id, {
        reason: "  unpaid invoice  ",
      });
      assert.isTrue(Option.isSome(suspended.suspendedAt));
      // Idempotent: suspending again keeps the original time.
      const again = yield* tenants.suspendOrganization(superadmin, org.id, {});
      assert.deepStrictEqual(again.suspendedAt, suspended.suspendedAt);

      const refused = yield* organization.get(owner, org.id).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "OrganizationNotFound");
      const listedByMember = yield* organization.list(owner);
      assert.isTrue(Option.isSome(listedByMember[0]?.suspendedAt ?? Option.none()));

      const reinstated = yield* tenants.unsuspendOrganization(superadmin, org.id);
      assert.isTrue(Option.isNone(reinstated.suspendedAt));
      assert.strictEqual((yield* organization.get(owner, org.id)).id, org.id);
    }).pipe(Effect.provide(buildLayer(superadminOnly))),
  );

  it.effect("suspension and reinstatement are published as audited events", () =>
    Effect.gen(function* () {
      const tenants = yield* AdminTenants.AdminTenants;
      const organization = yield* Organization.Organization;
      const auditLog = yield* AuditLog.AuditLog;
      const org = yield* organization.create({
        caller: asCaller("owner-1"),
        name: "Acme",
        slug: "acme",
      });
      const superadmin = asCaller("superadmin-1");
      yield* tenants.suspendOrganization(superadmin, org.id, { reason: "abuse" });
      yield* tenants.unsuspendOrganization(superadmin, org.id);
      const suspended = yield* auditLog.list({ eventTag: "auth.admin.organizationSuspended" });
      assert.strictEqual(suspended.length, 1);
      assert.deepStrictEqual(suspended[0]?.actorUserId, Option.some("superadmin-1"));
      const reinstated = yield* auditLog.list({ eventTag: "auth.admin.organizationUnsuspended" });
      assert.strictEqual(reinstated.length, 1);
    }).pipe(Effect.provide(buildLayer(superadminOnly))),
  );
});
