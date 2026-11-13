// EP-003 (ADR-EA-018, BEH-EA-237): the superadmin tenant-administration plugin,
// composed the way an application does — `Organization` beside `AdminTenants` —
// and driven domain-level, like `Admin.test.ts`.
import { Api } from "@awthaq/api";
import { Auth, AuditLog, CurrentUser, HookPoint } from "@awthaq/core";
import { Organization, OrganizationHooks } from "@awthaq/organization";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Admin from "../src/Admin.ts";
import * as AdminTenants from "../src/AdminTenants.ts";
import { TestAuth } from "@awthaq/test";

const buildLayer = (
  config: Partial<Admin.AdminConfigShape>,
  // Plan 04: taps on the organization hook points (a suspension veto, an observer).
  taps: Layer.Layer<
    never,
    never,
    Layer.Success<typeof OrganizationHooks.OrganizationHooksLive>
  > = Layer.empty,
) =>
  // `AdminTenants` `dependsOn: [Organization]`: the harness composes the organization plugin beneath it.
  TestAuth.layer(Auth.make([Organization.Organization, AdminTenants.AdminTenants]), {
    services: Layer.mergeAll(Admin.config(config), Organization.config({})),
    taps,
  });

const asCaller = (id: string): CurrentUser.Caller =>
  CurrentUser.of(
    new Api.UserPrincipal({
      ref: new Api.PrincipalRef({ type: "user", id }),
      sessionId: `${id}-session`,
    }),
  );

const superadminOnly: Partial<Admin.AdminConfigShape> = {
  canAdministerTenants: ({ admin }) => Effect.succeed(admin.id === "superadmin-1"),
};

describe("AdminTenants (BEH-EA-237)", () => {
  it.effect("the superadmin lists organizations keyset-paginated and reads one", () =>
    Effect.gen(function* () {
      const tenants = yield* AdminTenants.AdminTenants;
      const organization = yield* Organization.Organization;
      const superadmin = asCaller("superadmin-1");
      for (const slug of ["a", "b", "c", "d", "e"]) {
        yield* organization.create({
          caller: asCaller(`owner-${slug}`),
          name: slug,
          slug,
        });
      }
      const first = yield* tenants.listOrganizations(superadmin, {
        limit: 2,
      });
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

  it.effect("every page size traverses the exact ascending order across createdAt ties", () =>
    Effect.gen(function* () {
      const tenants = yield* AdminTenants.AdminTenants;
      const organization = yield* Organization.Organization;
      const superadmin = asCaller("superadmin-1");
      // Three organizations at T0, one at T1, three at T2.
      const created: Array<{ id: string; at: number }> = [];
      for (const [group, slugs] of [["a", "b", "c"], ["d"], ["e", "f", "g"]].entries()) {
        if (group > 0) yield* TestClock.adjust(Duration.millis(1));
        for (const slug of slugs) {
          const org = yield* organization.create({
            caller: asCaller(`owner-${slug}`),
            name: slug,
            slug,
          });
          created.push({ id: org.id, at: DateTime.toEpochMillis(org.createdAt) });
        }
      }
      const expected = created
        .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((row) => row.id);
      for (const limit of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const seen: Array<string> = [];
        let cursor: Option.Option<AdminTenants.OrganizationCursor> = Option.none();
        for (;;) {
          const page = yield* tenants.listOrganizations(superadmin, {
            limit,
            ...(Option.isSome(cursor) ? { cursor: cursor.value } : {}),
          });
          assert.isTrue(page.items.length > 0 || seen.length === 0);
          seen.push(...page.items.map((row) => row.id));
          if (Option.isNone(page.nextCursor)) break;
          cursor = page.nextCursor;
        }
        assert.deepStrictEqual(seen, expected, `limit ${limit}`);
      }
    }).pipe(Effect.provide(buildLayer(superadminOnly))),
  );

  it.effect("an in-process limit is normalised like Users.list", () =>
    Effect.gen(function* () {
      const tenants = yield* AdminTenants.AdminTenants;
      const organization = yield* Organization.Organization;
      const superadmin = asCaller("superadmin-1");
      for (const slug of ["a", "b", "c"]) {
        yield* organization.create({ caller: asCaller(`owner-${slug}`), name: slug, slug });
      }
      const sized = (limit: number) =>
        Effect.map(tenants.listOrganizations(superadmin, { limit }), (page) => [
          page.items.length,
          Option.isSome(page.nextCursor),
        ]);
      assert.deepStrictEqual(yield* sized(0), [1, true]);
      assert.deepStrictEqual(yield* sized(-3), [1, true]);
      assert.deepStrictEqual(yield* sized(2.5), [2, true]);
      assert.deepStrictEqual(yield* sized(Number.NaN), [3, false]);
      assert.deepStrictEqual(yield* sized(10_000), [3, false]);
    }).pipe(Effect.provide(buildLayer(superadminOnly))),
  );

  it.effect("a suspended organization refuses its members, and reinstating restores access", () =>
    Effect.gen(function* () {
      const tenants = yield* AdminTenants.AdminTenants;
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const superadmin = asCaller("superadmin-1");
      const org = yield* organization.create({
        caller: owner,
        name: "Acme",
        slug: "acme",
      });

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
      yield* tenants.suspendOrganization(superadmin, org.id, {
        reason: "abuse",
      });
      yield* tenants.unsuspendOrganization(superadmin, org.id);
      const suspended = yield* auditLog.list({
        eventTag: "auth.admin.organizationSuspended",
      });
      assert.strictEqual(suspended.length, 1);
      assert.deepStrictEqual(suspended[0]?.actorUserId, Option.some("superadmin-1"));
      const reinstated = yield* auditLog.list({
        eventTag: "auth.admin.organizationUnsuspended",
      });
      assert.strictEqual(reinstated.length, 1);
    }).pipe(Effect.provide(buildLayer(superadminOnly))),
  );

  it.effect(
    "suspension fires AfterSuspendOrganization with the administrator as actor, and reinstatement its pair",
    () => {
      const seen: Array<string> = [];
      return Effect.gen(function* () {
        const tenants = yield* AdminTenants.AdminTenants;
        const organization = yield* Organization.Organization;
        const org = yield* organization.create({
          caller: asCaller("owner-1"),
          name: "Acme",
          slug: "acme",
        });
        const superadmin = asCaller("superadmin-1");
        yield* tenants.suspendOrganization(superadmin, org.id, {
          reason: "abuse",
        });
        yield* tenants.unsuspendOrganization(superadmin, org.id);
        assert.deepStrictEqual(seen, [
          "suspended:PlatformAdmin:superadmin-1:abuse",
          "reinstated:PlatformAdmin:superadmin-1",
        ]);
      }).pipe(
        Effect.provide(
          buildLayer(
            superadminOnly,
            Layer.mergeAll(
              OrganizationHooks.AfterSuspendOrganization.tap((input) => {
                seen.push(
                  `suspended:${input.actor._tag}:${input.actor._tag === "PlatformAdmin" ? input.actor.adminUserId : ""}:${input.reason}`,
                );
                return Effect.void;
              }),
              OrganizationHooks.AfterReinstateOrganization.tap((input) => {
                seen.push(
                  `reinstated:${input.actor._tag}:${input.actor._tag === "PlatformAdmin" ? input.actor.adminUserId : ""}`,
                );
                return Effect.void;
              }),
            ),
          ),
        ),
      );
    },
  );

  it.effect(
    "a BeforeSuspendOrganization veto makes suspend HookAborted and leaves the organization active",
    () =>
      Effect.gen(function* () {
        const tenants = yield* AdminTenants.AdminTenants;
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-1");
        const org = yield* organization.create({
          caller: owner,
          name: "Acme",
          slug: "acme",
        });
        const refused = yield* tenants
          .suspendOrganization(asCaller("superadmin-1"), org.id, {})
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "HookAborted");
        assert.strictEqual((yield* organization.get(owner, org.id)).id, org.id);
      }).pipe(
        Effect.provide(
          buildLayer(
            superadminOnly,
            OrganizationHooks.BeforeSuspendOrganization.tap(() =>
              Effect.fail(new HookPoint.HookAbort({ code: "BILLING_HOLD" })),
            ),
          ),
        ),
      ),
  );
});
