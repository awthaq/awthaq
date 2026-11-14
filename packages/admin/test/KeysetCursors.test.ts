// KEY-04, architecture deepening batch 3 phase 3: pins the three keyset cursor wire encodings byte for byte
// (impersonation startedAt, users and organizations createdAt), on memory and SQL, green before and after the
// keyset module; written against the pre-refactor code. Cases are only ever added in this phase, never edited.
import { Api } from "@awthaq/api";
import { AuditChain, Auth, CurrentUser, Migrations, Users } from "@awthaq/core";
import { Organization } from "@awthaq/organization";
import { OrganizationRecords } from "@awthaq/organization/records";
import { UserStore } from "@awthaq/ports";
import { CoreMigrations, UserStoreSql } from "@awthaq/sql";
import { TenantScoped } from "@awthaq/sql";
import { TestAuth, TestSql } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Migrator from "effect/sql/Migrator";
import * as TestClock from "effect/testing/TestClock";
import * as Admin from "../src/Admin.ts";
import * as AdminApi from "../src/AdminApi.ts";
import * as AdminTenants from "../src/AdminTenants.ts";
import * as AdminTenantsApi from "../src/AdminTenantsApi.ts";
import * as ImpersonationRecords from "../src/ImpersonationRecords.ts";

const T0 = Date.parse("2026-03-01T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

/** The independent derivation of a wire cursor: base64url of the JSON text, key order included. */
const derive = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");

// ---- the pinned literals (captured by running the code before the keyset module) ---------------------------

const FIXED_ID = "018f0000-0000-7000-8000-000000000002";
/** `AdminApi.UserCursorSchema` and `AdminTenantsApi.OrganizationCursorSchema` over `{ T0 + 2 ms, FIXED_ID }`. */
const SCHEMA_CREATED_AT =
  "eyJjcmVhdGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwMloiLCJpZCI6IjAxOGYwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwMiJ9";
/** `AdminApi.CursorSchema` over `{ T0 + 2 ms, FIXED_ID }`. */
const SCHEMA_STARTED_AT =
  "eyJzdGFydGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwMloiLCJpZCI6IjAxOGYwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwMiJ9";

const USERS_AFTER_SECOND_TIE =
  "eyJjcmVhdGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwMVoiLCJpZCI6IjAxOGYwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwMiJ9";
const USERS_AFTER_FOURTH =
  "eyJjcmVhdGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwNVoiLCJpZCI6IjAxOGYwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwNCJ9";

const IMPERSONATION_AFTER_FIRST_PAGE =
  "eyJzdGFydGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwMloiLCJpZCI6IjAxOWNhNmIxLWRjMDItNzRiZC04YmI3LWM3YzA4NzJiNzYwMSJ9";
const IMPERSONATION_AFTER_SECOND_PAGE =
  "eyJzdGFydGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwMFoiLCJpZCI6IjAxOWNhNmIxLWRjMDAtNzBiZi1iOWI4LWVlYjVlMTc0YTY5YSJ9";

/**
 * A pinned literal equals what the wire schema produced, equals the independent derivation, is 112 characters
 * without `=` padding, and decodes to JSON whose first key is the timestamp and second key `id` (key order is
 * part of the bytes).
 */
const assertWire = (
  produced: string,
  literal: string,
  json: { readonly [key: string]: string },
  firstKey: "createdAt" | "startedAt",
) => {
  assert.strictEqual(produced, literal);
  assert.strictEqual(literal, derive(json));
  assert.strictEqual(literal.length, 112);
  assert.isFalse(literal.includes("="));
  assert.deepStrictEqual(Object.keys(JSON.parse(Buffer.from(literal, "base64url").toString())), [
    firstKey,
    "id",
  ]);
};

/** The cursor a walk produced after page `n`: what a page really answered, not a pinned literal. */
const cursorAfter = (
  pages: ReadonlyArray<{ readonly cursor: string | null }>,
  n: number,
): string => {
  const cursor = pages[n]?.cursor;
  if (cursor === undefined || cursor === null) return assert.fail(`page ${n} answered no cursor`);
  return cursor;
};

// ---- the three wire schemas ---------------------------------------------------------------------------------

describe("KEY-04: the wire schemas", () => {
  it("users and organizations encode `{ createdAt, id }` to the pinned bytes", () => {
    const position = { createdAt: DateTime.makeUnsafe(T0 + 2), id: FIXED_ID };
    const json = { createdAt: iso(T0 + 2), id: FIXED_ID };
    assertWire(
      Schema.encodeSync(AdminApi.UserCursorSchema)(position),
      SCHEMA_CREATED_AT,
      json,
      "createdAt",
    );
    assertWire(
      Schema.encodeSync(AdminTenantsApi.OrganizationCursorSchema)(position),
      SCHEMA_CREATED_AT,
      json,
      "createdAt",
    );
  });

  it("impersonations encode `{ startedAt, id }` to the pinned bytes", () => {
    assertWire(
      Schema.encodeSync(AdminApi.CursorSchema)({
        startedAt: DateTime.makeUnsafe(T0 + 2),
        id: FIXED_ID,
      }),
      SCHEMA_STARTED_AT,
      { startedAt: iso(T0 + 2), id: FIXED_ID },
      "startedAt",
    );
  });
});

// ---- users: (createdAt, id) ascending -----------------------------------------------------------------------

const userId = (n: number) => Users.UserId(`018f0000-0000-7000-8000-00000000000${n}`);

const newUser = (n: number, offsetMs: number): UserStore.NewUser => ({
  id: userId(n),
  email: Option.none(),
  emailVerified: false,
  phone: Option.none(),
  phoneVerified: false,
  name: `n${n}`,
  image: Option.none(),
  metadata: Option.none(),
  status: "active",
  statusReason: Option.none(),
  suspendedUntil: Option.none(),
  createdAt: DateTime.makeUnsafe(T0 + offsetMs),
  updatedAt: DateTime.makeUnsafe(T0 + offsetMs),
});

type UsersWorld = Users.Users | UserStore.UserStore;

const usersMemory: Layer.Layer<UsersWorld, unknown> = Users.layer.pipe(
  Layer.provideMerge(UserStore.layerMemory),
  Layer.provide(NodeCrypto.layer),
);

const usersSql: Layer.Layer<UsersWorld, unknown> = Users.layer.pipe(
  Layer.provideMerge(UserStoreSql.layer),
  Layer.provideMerge(
    Layer.effectDiscard(Migrator.make({})({ loader: CoreMigrations.coreMigrations })).pipe(
      Layer.provideMerge(TestSql.layer("keyset_cursors_users")),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

/** Ids 1@+0, 3@+1, 2@+1, 4@+5, 5@+5 (ms after T0), inserted in that order: two ties, out of id order. */
const userRows: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [3, 1],
  [2, 1],
  [4, 5],
  [5, 5],
];

const walkUsers = (limit: number) =>
  Effect.gen(function* () {
    const store = yield* UserStore.UserStore;
    const users = yield* Users.Users;
    for (const [n, offset] of userRows) yield* store.insertOrHolder(newUser(n, offset));
    const pages: Array<{ readonly ids: ReadonlyArray<string>; readonly cursor: string | null }> =
      [];
    let cursor: Users.UserCursor | undefined = undefined;
    for (;;) {
      const page: Users.UsersPage = yield* users.list({
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      pages.push({
        ids: page.items.map((user) => user.id.slice(-1)),
        cursor: Option.isSome(page.nextCursor)
          ? Schema.encodeSync(AdminApi.UserCursorSchema)(page.nextCursor.value)
          : null,
      });
      if (Option.isNone(page.nextCursor)) break;
      cursor = page.nextCursor.value;
    }
    return pages;
  });

const usersCases = (leg: string, layer: Layer.Layer<UsersWorld, unknown>) => {
  describe(`KEY-04: users keyset pages (${leg})`, () => {
    it.effect("limit 2 walks [1,2] [3,4] [5] with the two pinned cursors", () =>
      Effect.gen(function* () {
        const pages = yield* walkUsers(2);
        assert.deepStrictEqual(pages, [
          { ids: ["1", "2"], cursor: USERS_AFTER_SECOND_TIE },
          { ids: ["3", "4"], cursor: USERS_AFTER_FOURTH },
          { ids: ["5"], cursor: null },
        ]);
        assertWire(
          cursorAfter(pages, 0),
          USERS_AFTER_SECOND_TIE,
          { createdAt: iso(T0 + 1), id: userId(2) },
          "createdAt",
        );
        assertWire(
          cursorAfter(pages, 1),
          USERS_AFTER_FOURTH,
          { createdAt: iso(T0 + 5), id: userId(4) },
          "createdAt",
        );
      }).pipe(Effect.provide(layer)),
    );

    it.effect("limit 4 gives [1..4] with the pinned cursor, then [5]", () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* walkUsers(4), [
          { ids: ["1", "2", "3", "4"], cursor: USERS_AFTER_FOURTH },
          { ids: ["5"], cursor: null },
        ]);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("limit 5 over 5 rows is exactly full: one page, no cursor", () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* walkUsers(5), [
          { ids: ["1", "2", "3", "4", "5"], cursor: null },
        ]);
      }).pipe(Effect.provide(layer)),
    );
  });
};

usersCases("memory", usersMemory);
usersCases("sql", usersSql);

// ---- impersonations: (startedAt, id) descending -------------------------------------------------------------

/** A seeded xorshift32 generator: a fresh one per layer build, so the memory and SQL legs mint the same ids. */
const seededBytes = () => {
  let state = 0x9e3779b9;
  return (size: number): Uint8Array => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      bytes[i] = state & 0xff;
    }
    return bytes;
  };
};

const impersonationBase = Layer.mergeAll(
  AuditChain.layer.pipe(Layer.provide(NodeCrypto.layer)),
  Layer.sync(SecureRandom.SecureRandom, () => SecureRandom.make(seededBytes())),
);

const impersonationMemory: Layer.Layer<ImpersonationRecords.ImpersonationRecords, unknown> =
  ImpersonationRecords.layerMemory.pipe(Layer.provide(impersonationBase));

const impersonationSql: Layer.Layer<ImpersonationRecords.ImpersonationRecords, unknown> =
  ImpersonationRecords.layerSql.pipe(
    Layer.provide(impersonationBase),
    Layer.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          yield* Migrator.make({})({
            loader: CoreMigrations.coreMigrations,
            table: "effect_sql_migrations",
          });
          yield* Migrations.run(Auth.make([Admin.Admin]).migrations);
        }),
      ).pipe(Layer.provideMerge(TestSql.layer("keyset_cursors_imp"))),
    ),
  );

const CREATION_IDS = [
  "019ca6b1-dc00-70bf-b9b8-eeb4d33cb85f",
  "019ca6b1-dc00-70bf-b9b8-eeb5e174a69a",
  "019ca6b1-dc00-70bf-b9b8-eeb676653da6",
  "019ca6b1-dc01-7768-b7e5-29b894982ec0",
  "019ca6b1-dc02-74bd-8bb7-c7c0872b7601",
  "019ca6b1-dc02-74bd-8bb7-c7c11c090ff8",
  "019ca6b1-dc02-74bd-8bb7-c7c2a935e055",
];

/** Groups of 3@+0, 1@+1, 3@+2 ms; session ids `s-<group>-<n>`. */
const impersonationGroups: ReadonlyArray<readonly [number, number]> = [
  [0, 3],
  [1, 1],
  [2, 3],
];

const walkImpersonations = (limit: number) =>
  Effect.gen(function* () {
    const records = yield* ImpersonationRecords.ImpersonationRecords;
    const created: Array<ImpersonationRecords.ImpersonationRecord> = [];
    for (const [group, count] of impersonationGroups) {
      yield* TestClock.setTime(T0 + group);
      for (let n = 0; n < count; n++) {
        created.push(
          yield* records.create({
            adminUserId: Users.UserId("admin-1"),
            targetUserId: Users.UserId("target-1"),
            sessionId: `s-${group}-${n}`,
            reason: "r",
            expiresAt: DateTime.makeUnsafe(T0 + 3_600_000),
          }),
        );
      }
    }
    const pages: Array<{
      readonly sessions: ReadonlyArray<string>;
      readonly cursor: string | null;
    }> = [];
    let cursor: ImpersonationRecords.ImpersonationCursor | undefined = undefined;
    for (;;) {
      const page: ImpersonationRecords.ImpersonationPage = yield* records.list({
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      pages.push({
        sessions: page.items.map((row) => row.sessionId),
        cursor: Option.isSome(page.nextCursor)
          ? Schema.encodeSync(AdminApi.CursorSchema)(page.nextCursor.value)
          : null,
      });
      if (Option.isNone(page.nextCursor)) break;
      cursor = page.nextCursor.value;
    }
    return { ids: created.map((row) => row.id), pages };
  });

const impersonationCases = (
  leg: string,
  layer: Layer.Layer<ImpersonationRecords.ImpersonationRecords, unknown>,
) => {
  describe(`KEY-04: impersonation keyset pages (${leg})`, () => {
    it.effect(
      "limit 3 walks newest-first, ties by id descending, with the two pinned cursors",
      () =>
        Effect.gen(function* () {
          const walk = yield* walkImpersonations(3);
          // A mismatch here points at the fixture (the seeded generator), not at the cursor bytes.
          assert.deepStrictEqual(walk.ids, CREATION_IDS);
          assert.deepStrictEqual(walk.pages, [
            {
              sessions: ["s-2-2", "s-2-1", "s-2-0"],
              cursor: IMPERSONATION_AFTER_FIRST_PAGE,
            },
            {
              sessions: ["s-1-0", "s-0-2", "s-0-1"],
              cursor: IMPERSONATION_AFTER_SECOND_PAGE,
            },
            { sessions: ["s-0-0"], cursor: null },
          ]);
          assertWire(
            cursorAfter(walk.pages, 0),
            IMPERSONATION_AFTER_FIRST_PAGE,
            { startedAt: iso(T0 + 2), id: "019ca6b1-dc02-74bd-8bb7-c7c0872b7601" },
            "startedAt",
          );
          assertWire(
            cursorAfter(walk.pages, 1),
            IMPERSONATION_AFTER_SECOND_PAGE,
            { startedAt: iso(T0), id: "019ca6b1-dc00-70bf-b9b8-eeb5e174a69a" },
            "startedAt",
          );
        }).pipe(Effect.provide(layer)),
    );
  });
};

impersonationCases("memory", impersonationMemory);
impersonationCases("sql", impersonationSql);

// ---- organizations: (createdAt, id) ascending, through AdminTenants ---------------------------------------------

const asCaller = (id: string): CurrentUser.Caller =>
  CurrentUser.of(
    new Api.UserPrincipal({
      ref: new Api.PrincipalRef({ type: "user", id }),
      sessionId: `${id}-session`,
    }),
  );

const organizationOptions = {
  services: Layer.mergeAll(
    Admin.config({
      canAdministerTenants: ({ admin }) => Effect.succeed(admin.id === "superadmin-1"),
    }),
    Organization.config({}),
  ),
};
const organizationPlugins = Auth.make([Organization.Organization, AdminTenants.AdminTenants]);

const organizationMemory = TestAuth.layer(organizationPlugins, organizationOptions);
const organizationSql = TestAuth.layer(organizationPlugins, {
  ...organizationOptions,
  records: "sql",
  suite: "keyset_cursors_org",
});

/** Slugs a,b,c@+0, d@+1, e,f,g@+2 ms. */
const organizationGroups: ReadonlyArray<readonly [number, ReadonlyArray<string>]> = [
  [0, ["a", "b", "c"]],
  [1, ["d"]],
  [2, ["e", "f", "g"]],
];

const organizationCases = (
  leg: string,
  layer: Layer.Layer<AdminTenants.AdminTenants | Organization.Organization, unknown>,
) => {
  describe(`KEY-04: organization keyset pages (${leg})`, () => {
    // Ids are random here, so each cursor is checked against the independent derivation from the last kept item.
    it.effect(
      "limit 3 over a,b,c@+0 d@+1 e,f,g@+2 gives pages of 3, 3, 1 and derived cursors",
      () =>
        Effect.gen(function* () {
          const tenants = yield* AdminTenants.AdminTenants;
          const organization = yield* Organization.Organization;
          const superadmin = asCaller("superadmin-1");
          const created: Array<{ readonly id: string; readonly at: number }> = [];
          for (const [group, slugs] of organizationGroups) {
            yield* TestClock.setTime(T0 + group);
            for (const slug of slugs) {
              const org = yield* organization.create({
                caller: asCaller(`owner-${slug}`),
                name: slug,
                slug,
              });
              created.push({ id: org.id, at: DateTime.toEpochMillis(org.createdAt) });
            }
          }

          const pages: Array<ReadonlyArray<string>> = [];
          const wires: Array<string | null> = [];
          let cursor: AdminTenants.OrganizationCursor | undefined = undefined;
          for (;;) {
            const page: AdminTenants.OrganizationPage = yield* tenants.listOrganizations(
              superadmin,
              {
                limit: 3,
                ...(cursor === undefined ? {} : { cursor }),
              },
            );
            pages.push(page.items.map((item) => item.id));
            wires.push(
              Option.isSome(page.nextCursor)
                ? Schema.encodeSync(AdminTenantsApi.OrganizationCursorSchema)(page.nextCursor.value)
                : null,
            );
            if (Option.isNone(page.nextCursor)) break;
            cursor = page.nextCursor.value;
          }

          const expected = [...created]
            .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .map((row) => row.id);
          assert.deepStrictEqual(
            pages.map((ids) => ids.length),
            [3, 3, 1],
          );
          assert.deepStrictEqual(pages.flat(), expected);
          assert.deepStrictEqual(wires, [
            derive({ createdAt: iso(T0), id: pages[0]?.[2] }),
            derive({ createdAt: iso(T0 + 2), id: pages[1]?.[2] }),
            null,
          ]);
          for (const wire of wires) {
            if (wire === null) continue;
            assert.strictEqual(wire.length, 112);
            assert.isFalse(wire.includes("="));
            assert.deepStrictEqual(
              Object.keys(JSON.parse(Buffer.from(wire, "base64url").toString())),
              ["createdAt", "id"],
            );
          }
        }).pipe(Effect.provide(layer)),
    );
  });
};

organizationCases("memory", organizationMemory);
organizationCases("sql records", organizationSql);

// ---- organizations, records level: the two cursors of today's code ---------------------------------------------

/** `OrganizationCursorSchema` over `{ T0, c }` and `{ T0 + 2 ms, f }` of the seeded creation ids (captured from the code before the keyset module). */
const ORG_N1 =
  "eyJjcmVhdGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwMFoiLCJpZCI6IjAxOWNhNmIxLWRjMDAtNzBiZi1iOWI4LWVlYjY3NjY1M2RhNiJ9";
const ORG_N2 =
  "eyJjcmVhdGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwMloiLCJpZCI6IjAxOWNhNmIxLWRjMDItNzRiZC04YmI3LWM3YzExYzA5MGZmOCJ9";

const organizationRecordsBase = Layer.sync(SecureRandom.SecureRandom, () =>
  SecureRandom.make(seededBytes()),
);

const organizationRecordsMemory: Layer.Layer<OrganizationRecords.OrganizationRecords, unknown> =
  OrganizationRecords.layerMemory.pipe(Layer.provide(organizationRecordsBase));

const organizationRecordsSql: Layer.Layer<OrganizationRecords.OrganizationRecords, unknown> =
  OrganizationRecords.layerSql.pipe(
    Layer.provide(organizationRecordsBase),
    Layer.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          yield* Migrator.make({})({
            loader: CoreMigrations.coreMigrations,
            table: "effect_sql_migrations",
          });
          yield* Migrations.run(Auth.make([Organization.Organization]).migrations);
        }),
      ).pipe(Layer.provideMerge(TestSql.layer("keyset_cursors_org_records"))),
    ),
  );

const organizationsGrant = TenantScoped.crossTenant("keyset cursors test: the platform listing");

const organizationRecordsCases = (
  leg: string,
  layer: Layer.Layer<OrganizationRecords.OrganizationRecords, unknown>,
) => {
  describe(`organizations, records level (ORG_N1, ORG_N2 from today's code) (${leg})`, () => {
    it.effect("limit 3 over seven seeded ids gives [a,b,c] ORG_N1, [d,e,f] ORG_N2, [g] none", () =>
      Effect.gen(function* () {
        const records = yield* OrganizationRecords.OrganizationRecords;
        const ids: Array<string> = [];
        for (const [group, slugs] of organizationGroups) {
          yield* TestClock.setTime(T0 + group);
          for (const slug of slugs) {
            ids.push((yield* records.create({ name: slug, slug })).id);
          }
        }
        // A mismatch here points at the fixture (the seeded generator), not at the cursor bytes.
        assert.deepStrictEqual(ids, CREATION_IDS);

        const pages: Array<{
          readonly ids: ReadonlyArray<string>;
          readonly cursor: string | null;
        }> = [];
        let after: Option.Option<OrganizationRecords.OrganizationCursor> = Option.none();
        for (;;) {
          const page = yield* records.listPage(organizationsGrant, { after, limit: 3 });
          pages.push({
            ids: page.items.map((row) => row.id),
            cursor: Option.isSome(page.nextCursor)
              ? Schema.encodeSync(AdminTenantsApi.OrganizationCursorSchema)(page.nextCursor.value)
              : null,
          });
          if (Option.isNone(page.nextCursor)) break;
          after = page.nextCursor;
        }
        assert.deepStrictEqual(pages, [
          { ids: CREATION_IDS.slice(0, 3), cursor: ORG_N1 },
          { ids: CREATION_IDS.slice(3, 6), cursor: ORG_N2 },
          { ids: CREATION_IDS.slice(6), cursor: null },
        ]);
        assert.strictEqual(ORG_N1, derive({ createdAt: iso(T0), id: CREATION_IDS[2] }));
        assert.strictEqual(ORG_N2, derive({ createdAt: iso(T0 + 2), id: CREATION_IDS[5] }));
      }).pipe(Effect.provide(layer)),
    );
  });
};

organizationRecordsCases("memory", organizationRecordsMemory);
organizationRecordsCases("sql", organizationRecordsSql);
