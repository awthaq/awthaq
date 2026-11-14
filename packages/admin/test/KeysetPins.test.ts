// Architecture deepening batch 3, phase 3, Wave 0 pin matrix: today's caller-visible page behaviour of
// `Users.list`, `AdminTenants.listOrganizations` and `Admin.list`, written against the pre-refactor code; the keyset refactor must keep every case green unchanged.
import { Api } from "@awthaq/api";
import { Auth, CurrentUser, Tenant, Users } from "@awthaq/core";
import { Organization } from "@awthaq/organization";
import { UserStore } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Admin from "../src/Admin.ts";
import * as AdminTenants from "../src/AdminTenants.ts";
import * as ImpersonationRecords from "../src/ImpersonationRecords.ts";

const T0 = Date.parse("2026-03-01T00:00:00.000Z");

const asCaller = (id: string): CurrentUser.Caller =>
  CurrentUser.of(
    new Api.UserPrincipal({
      ref: new Api.PrincipalRef({ type: "user", id }),
      sessionId: `${id}-session`,
    }),
  );

// ---- the shared walker and the expectation, independent of every production comparator ------------------------

/** One seeded row: its id and creation instant in epoch milliseconds. */
interface Row {
  readonly id: string;
  readonly at: number;
}

interface PageInput<C> {
  readonly limit?: number;
  readonly cursor?: C;
}

interface PageOf<C> {
  readonly items: ReadonlyArray<{ readonly id: string }>;
  readonly nextCursor: Option.Option<C>;
}

const codeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Ids in ascending (instant, id by code unit) order; descending is its exact reverse. */
const expectedOrder = (rows: ReadonlyArray<Row>, descending: boolean): ReadonlyArray<string> => {
  const ascending = [...rows]
    .sort((a, b) => a.at - b.at || codeUnit(a.id, b.id))
    .map((row) => row.id);
  return descending ? ascending.reverse() : ascending;
};

/** Follows the cursor from the first page; every page is recorded as its ids and whether a cursor came back. */
const walk = <C, E, R>(
  list: (input: PageInput<C>) => Effect.Effect<PageOf<C>, E, R>,
  limit?: number,
) =>
  Effect.gen(function* () {
    const pages: Array<{ readonly ids: ReadonlyArray<string>; readonly more: boolean }> = [];
    let cursor: C | undefined = undefined;
    for (;;) {
      const page: PageOf<C> = yield* list({
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      pages.push({ ids: page.items.map((item) => item.id), more: Option.isSome(page.nextCursor) });
      if (Option.isNone(page.nextCursor)) return pages;
      assert.isTrue(pages.length < 300, "the walk never ends");
      cursor = page.nextCursor.value;
    }
  });

const shape = (
  pages: ReadonlyArray<{ readonly ids: ReadonlyArray<string>; readonly more: boolean }>,
) => pages.map((page) => [page.ids.length, page.more]);

interface Listing<C, R> {
  readonly name: string;
  readonly layer: Layer.Layer<R, unknown>;
  /** One tie group per entry: that many rows created at `T0 + group index` ms. */
  readonly seed: (groups: ReadonlyArray<number>) => Effect.Effect<ReadonlyArray<Row>, unknown, R>;
  readonly list: (input: PageInput<C>) => Effect.Effect<PageOf<C>, unknown, R>;
  readonly descending: boolean;
}

/** The page behaviour every listing shares: defaults, maxima, clamping, ties, exactly-full pages. */
const sharedCases = <C, R>(listing: Listing<C, R>) => {
  describe(`${listing.name}: page behaviour`, () => {
    it.effect("51 rows and no limit answer 50 and a cursor, then 1 and none", () =>
      Effect.gen(function* () {
        yield* listing.seed([51]);
        assert.deepStrictEqual(shape(yield* walk(listing.list)), [
          [50, true],
          [1, false],
        ]);
      }).pipe(Effect.provide(listing.layer)),
    );

    it.effect("201 rows answer 200 and a cursor at limit 200 and at limit 10_000", () =>
      Effect.gen(function* () {
        yield* listing.seed([201]);
        for (const limit of [200, 10_000]) {
          const page = yield* listing.list({ limit });
          assert.strictEqual(page.items.length, 200, `limit ${limit}`);
          assert.isTrue(Option.isSome(page.nextCursor), `limit ${limit}`);
        }
      }).pipe(Effect.provide(listing.layer)),
    );

    it.effect("over 3 rows the limits 0, -3, 2.5, NaN and 10_000 clamp to 1, 1, 2, 50, 200", () =>
      Effect.gen(function* () {
        yield* listing.seed([3]);
        const answers: Array<[number, number, boolean]> = [];
        for (const limit of [0, -3, 2.5, Number.NaN, 10_000]) {
          const page = yield* listing.list({ limit });
          answers.push([limit, page.items.length, Option.isSome(page.nextCursor)]);
        }
        assert.deepStrictEqual(
          answers.map(([, count, more]) => [count, more]),
          [
            [1, true],
            [1, true],
            [2, true],
            [3, false],
            [3, false],
          ],
        );
      }).pipe(Effect.provide(listing.layer)),
    );

    it.effect("7 rows in tie groups 3, 1, 3: every limit 1..8 walks every row once, in order", () =>
      Effect.gen(function* () {
        const rows = yield* listing.seed([3, 1, 3]);
        const expected = expectedOrder(rows, listing.descending);
        for (const limit of [1, 2, 3, 4, 5, 6, 7, 8]) {
          const pages = yield* walk(listing.list, limit);
          assert.deepStrictEqual(
            pages.flatMap((page) => page.ids),
            expected,
            `limit ${limit}`,
          );
          assert.strictEqual(pages.length, Math.ceil(7 / limit), `limit ${limit}`);
          assert.deepStrictEqual(
            pages.map((page) => page.more),
            pages.map((_, index) => index < pages.length - 1),
            `limit ${limit}`,
          );
        }
      }).pipe(Effect.provide(listing.layer)),
    );

    it.effect("a final page holding exactly `limit` rows has no cursor", () =>
      Effect.gen(function* () {
        yield* listing.seed([5]);
        assert.deepStrictEqual(shape(yield* walk(listing.list, 5)), [[5, false]]);
        assert.deepStrictEqual(shape(yield* walk(listing.list, 4)), [
          [4, true],
          [1, false],
        ]);
      }).pipe(Effect.provide(listing.layer)),
    );
  });
};

// ---- users --------------------------------------------------------------------------------------------------------

const usersLayer: Layer.Layer<Users.Users, unknown> = Users.layer.pipe(
  Layer.provide(UserStore.layerMemory),
  Layer.provide(NodeCrypto.layer),
);

sharedCases<Users.UserCursor, Users.Users>({
  name: "Users.list",
  layer: usersLayer,
  descending: false,
  seed: (groups) =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const rows: Array<Row> = [];
      let n = 0;
      for (const [group, count] of groups.entries()) {
        yield* TestClock.setTime(T0 + group);
        for (let i = 0; i < count; i++) {
          const user = yield* users.create({
            identity: { _tag: "Email", email: `user-${n}@example.com` },
            name: `user-${n}`,
          });
          rows.push({ id: user.id, at: DateTime.toEpochMillis(user.createdAt) });
          n++;
        }
      }
      return rows;
    }),
  list: (input) => Effect.flatMap(Effect.service(Users.Users), (users) => users.list(input)),
});

// ---- organizations, listed as the superadmin --------------------------------------------------------------------

const superadmin = asCaller("superadmin-1");

const organizationsLayer = TestAuth.layer(
  Auth.make([Organization.Organization, AdminTenants.AdminTenants]),
  {
    services: Layer.mergeAll(
      Admin.config({
        canAdministerTenants: ({ admin }) => Effect.succeed(admin.id === "superadmin-1"),
      }),
      Organization.config({}),
    ),
  },
);

sharedCases<AdminTenants.OrganizationCursor, Organization.Organization | AdminTenants.AdminTenants>(
  {
    name: "AdminTenants.listOrganizations",
    layer: organizationsLayer,
    descending: false,
    seed: (groups) =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const rows: Array<Row> = [];
        let n = 0;
        for (const [group, count] of groups.entries()) {
          yield* TestClock.setTime(T0 + group);
          for (let i = 0; i < count; i++) {
            const org = yield* organization.create({
              caller: asCaller(`owner-${n}`),
              name: `org-${n}`,
              slug: `org-${n}`,
            });
            rows.push({ id: org.id, at: DateTime.toEpochMillis(org.createdAt) });
            n++;
          }
        }
        return rows;
      }),
    list: (input) =>
      Effect.flatMap(Effect.service(AdminTenants.AdminTenants), (tenants) =>
        tenants.listOrganizations(superadmin, input),
      ),
  },
);

// ---- impersonation history through Admin.list -------------------------------------------------------------------

const adminLayer = (config: Partial<Admin.AdminConfigShape>) =>
  TestAuth.layer(Auth.make([Admin.Admin]), { services: Admin.config(config) });

const allowAll: Partial<Admin.AdminConfigShape> = {
  canManageEpisode: () => Effect.succeed(true),
};

/** One tie group per entry; `reasons` (when given) names the rows in creation order. */
const seedEpisodes = (
  groups: ReadonlyArray<number>,
  options: {
    readonly tenant?: string;
    readonly reasons?: ReadonlyArray<string>;
    /** Milliseconds after `T0` of the first group. */
    readonly start?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const records = yield* ImpersonationRecords.ImpersonationRecords;
    const rows: Array<Row & { readonly sessionId: string }> = [];
    let n = 0;
    for (const [group, count] of groups.entries()) {
      yield* TestClock.setTime(T0 + (options.start ?? 0) + group);
      for (let i = 0; i < count; i++) {
        const create = records.create({
          adminUserId: Users.UserId("admin-1"),
          targetUserId: Users.UserId("target-1"),
          sessionId: `s-${options.tenant ?? "none"}-${n}`,
          reason: options.reasons?.[n] ?? `r-${n}`,
          // Ten years ahead, so the sweep inside `Admin.list` ends nothing.
          expiresAt: DateTime.makeUnsafe(T0 + 315_360_000_000),
        });
        const record = yield* options.tenant === undefined
          ? create
          : create.pipe(Tenant.withTenant(options.tenant));
        rows.push({
          id: record.id,
          at: DateTime.toEpochMillis(record.startedAt),
          sessionId: record.sessionId,
        });
        n++;
      }
    }
    return rows;
  }).pipe(TestAuth.withoutRequest);

const adminCaller = asCaller("admin-1");

const listEpisodes = (input: PageInput<ImpersonationRecords.ImpersonationCursor>) =>
  Effect.flatMap(Effect.service(Admin.Admin), (admin) => admin.list(adminCaller, input)).pipe(
    TestAuth.withoutRequest,
  );

sharedCases<
  ImpersonationRecords.ImpersonationCursor,
  ImpersonationRecords.ImpersonationRecords | Admin.Admin
>({
  name: "Admin.list",
  layer: adminLayer(allowAll),
  descending: true,
  seed: (groups) => seedEpisodes(groups),
  list: listEpisodes,
});

describe("Admin.list: the gate runs after paging", () => {
  it.effect("a hidden episode shortens its page while the cursor still points onward", () =>
    Effect.gen(function* () {
      // shown-1@+0, hidden@+1, shown-2@+2; newest first the first two rows are shown-2 and hidden.
      yield* seedEpisodes([1, 1, 1], { reasons: ["shown-1", "hidden", "shown-2"] });
      const first = yield* listEpisodes({ limit: 2 });
      assert.deepStrictEqual(
        first.items.map((item) => item.reason),
        ["shown-2"],
      );
      assert.isTrue(Option.isSome(first.nextCursor));
      const second = yield* listEpisodes({
        limit: 2,
        ...(Option.isSome(first.nextCursor) ? { cursor: first.nextCursor.value } : {}),
      });
      assert.deepStrictEqual(
        second.items.map((item) => item.reason),
        ["shown-1"],
      );
      assert.isTrue(Option.isNone(second.nextCursor));
    }).pipe(
      Effect.provide(
        adminLayer({
          canManageEpisode: ({ episode }) => Effect.succeed(episode.reason !== "hidden"),
        }),
      ),
    ),
  );
});

describe("Admin.list: filters", () => {
  it.effect("{ active: true } skips an ended episode inside a tie group at every limit 1..4", () =>
    Effect.gen(function* () {
      const rows = yield* seedEpisodes([3, 1, 3]);
      const ended = rows[5];
      assert.isDefined(ended);
      const records = yield* ImpersonationRecords.ImpersonationRecords;
      yield* records.endEpisode(ended?.sessionId ?? "", "self");
      const expected = expectedOrder(
        rows.filter((row) => row.id !== ended?.id),
        true,
      );
      const activeOnly = (input: PageInput<ImpersonationRecords.ImpersonationCursor>) =>
        Effect.flatMap(Effect.service(Admin.Admin), (admin) =>
          admin.list(adminCaller, { ...input, active: true }),
        ).pipe(TestAuth.withoutRequest);
      for (const limit of [1, 2, 3, 4]) {
        const pages = yield* walk(activeOnly, limit);
        const seen = pages.flatMap((page) => page.ids);
        assert.deepStrictEqual(seen, expected, `limit ${limit}`);
        assert.isFalse(seen.includes(ended?.id ?? ""), `limit ${limit}`);
      }
    }).pipe(Effect.provide(adminLayer(allowAll))),
  );

  it.effect(
    'pages under Tenant.withTenant("org-a") never hold an org-b row, even on a replayed cursor',
    () =>
      Effect.gen(function* () {
        // org-a@+0, org-b@+1, org-a@+2, org-b@+3, org-a@+4, org-b@+5, interleaved in time.
        const rows: Array<Row & { readonly tenant: string }> = [];
        for (const [at, tenant] of [
          "org-a",
          "org-b",
          "org-a",
          "org-b",
          "org-a",
          "org-b",
        ].entries()) {
          const [row] = yield* seedEpisodes([1], { tenant, start: at });
          assert.isDefined(row);
          if (row !== undefined) rows.push({ ...row, tenant });
        }
        const idsOf = (tenant: string) => rows.filter((row) => row.tenant === tenant);
        const inTenant = (
          tenant: string,
          input: PageInput<ImpersonationRecords.ImpersonationCursor>,
        ) => listEpisodes(input).pipe(Tenant.withTenant(tenant));

        for (const limit of [1, 2, 3, 4]) {
          const pages = yield* walk(
            (input: PageInput<ImpersonationRecords.ImpersonationCursor>) =>
              inTenant("org-a", input),
            limit,
          );
          assert.deepStrictEqual(
            pages.flatMap((page) => page.ids),
            expectedOrder(idsOf("org-a"), true),
            `limit ${limit}`,
          );
        }

        // An org-a cursor replayed under org-b: only org-b rows strictly after it, newest first.
        const firstOfA = yield* inTenant("org-a", { limit: 2 });
        assert.deepStrictEqual(
          firstOfA.items.map((item) => item.id),
          expectedOrder(idsOf("org-a"), true).slice(0, 2),
        );
        assert.isTrue(Option.isSome(firstOfA.nextCursor));
        const replayed = yield* inTenant("org-b", {
          limit: 10,
          ...(Option.isSome(firstOfA.nextCursor) ? { cursor: firstOfA.nextCursor.value } : {}),
        });
        const position = Option.isSome(firstOfA.nextCursor)
          ? {
              at: DateTime.toEpochMillis(firstOfA.nextCursor.value.startedAt),
              id: firstOfA.nextCursor.value.id,
            }
          : { at: 0, id: "" };
        assert.deepStrictEqual(
          replayed.items.map((item) => item.id),
          expectedOrder(idsOf("org-b"), true).filter((id) => {
            const row = rows.find((candidate) => candidate.id === id);
            return (
              row !== undefined &&
              (row.at < position.at || (row.at === position.at && row.id < position.id))
            );
          }),
        );
        assert.isTrue(Option.isNone(replayed.nextCursor));
      }).pipe(Effect.provide(adminLayer(allowAll))),
  );
});
