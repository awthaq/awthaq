// Architecture deepening batch 3, phase 3, Wave 0 wire pins: the organization cursor bytes and the limit and cursor bounds on
// the admin listing routes, written against the pre-refactor code; the keyset refactor must keep every case green unchanged.
import { Api } from "@awthaq/api";
import { Auth, CurrentUser, Sessions, Users } from "@awthaq/core";
import { Organization } from "@awthaq/organization";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Admin from "../src/Admin.ts";
import * as AdminTenants from "../src/AdminTenants.ts";
import * as AdminTenantsApi from "../src/AdminTenantsApi.ts";

const ORIGIN = "http://localhost:3000";

const onlySuperadmin = ({ admin }: { readonly admin: { readonly id: string } }) =>
  Effect.succeed(admin.id === "superadmin-1");

const asCaller = (id: string): CurrentUser.Caller =>
  CurrentUser.of(
    new Api.UserPrincipal({
      ref: new Api.PrincipalRef({ type: "user", id }),
      sessionId: `${id}-session`,
    }),
  );

/** The raw wire view of a page: the cursor exactly as the server wrote it, before any schema decodes it. */
const RawPage = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String, createdAt: Schema.String })),
  nextCursor: Schema.NullOr(Schema.String),
});

const buildHandler = Effect.fn(function* () {
  const app = yield* TestAuth.serve(
    TestAuth.layer(Auth.make([Organization.Organization, AdminTenants.AdminTenants, Admin.Admin]), {
      services: Layer.mergeAll(
        Admin.config({ canAdministerTenants: onlySuperadmin, canManageUsers: onlySuperadmin }),
        Organization.config({}),
      ),
    }),
    { baseUrl: ORIGIN, testClock: true },
  );

  /** A browser holding a fresh session of `userId` (which need not be a `Users` row: the admin gate is the predicate). */
  const signInAs = async (userId: string) => {
    const setCookie = await app.run(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions
          .issue({ userId: Users.UserId(userId) })
          .pipe(TestAuth.withoutRequest);
        return yield* TestAuth.sessionSetCookie(issued);
      }),
    );
    const browser = await app.agent();
    assert.strictEqual(browser.cookies.receive(setCookie)._tag, "Stored");
    return browser;
  };

  /** Three organizations, a 1 ms step apart, so their creation instants are distinct. */
  const seedOrganizations = async () => {
    for (const slug of ["a", "b", "c"]) {
      await app.advance(Duration.millis(1));
      await app.run(
        Effect.flatMap(Effect.service(Organization.Organization), (organization) =>
          organization.create({ caller: asCaller(`owner-${slug}`), name: slug, slug }),
        ),
      );
    }
  };

  return { signInAs, seedOrganizations };
});

describe("admin listing routes (real HTTP)", () => {
  it.effect(
    "/admin/organizations?limit=2 puts the second item's (createdAt, id) on the wire as base64url JSON",
    () =>
      Effect.gen(function* () {
        const { signInAs, seedOrganizations } = yield* buildHandler();
        yield* Effect.promise(seedOrganizations);
        const superadmin = yield* Effect.promise(() => signInAs("superadmin-1"));

        const first = yield* Effect.promise(() =>
          superadmin.request("GET", "/admin/organizations?limit=2"),
        );
        assert.strictEqual(first.status, 200);
        const body = yield* Effect.promise(() => first.json());
        const raw = Schema.decodeUnknownSync(RawPage)(body);
        assert.strictEqual(raw.items.length, 2);
        const second = raw.items[1];
        assert.isDefined(second);
        const expected = Buffer.from(
          JSON.stringify({ createdAt: second?.createdAt, id: second?.id }),
        ).toString("base64url");
        assert.strictEqual(raw.nextCursor, expected);
        // The page also decodes with the wire schema, which parses that same cursor.
        const page = Schema.decodeUnknownSync(AdminTenantsApi.TenantOrganizationPageDto)(body);
        assert.strictEqual(page.items.length, 2);
        assert.isNotNull(page.nextCursor);

        const next = yield* Effect.promise(() =>
          superadmin.request("GET", `/admin/organizations?limit=2&cursor=${expected}`),
        );
        assert.strictEqual(next.status, 200);
        const nextBody = yield* Effect.promise(() => next.json());
        const nextPage = Schema.decodeUnknownSync(AdminTenantsApi.TenantOrganizationPageDto)(
          nextBody,
        );
        assert.strictEqual(nextPage.items.length, 1);
        assert.isNull(nextPage.nextCursor);
        // The three pages' items are the three organizations, once each, in creation order.
        assert.deepStrictEqual(
          [...page.items, ...nextPage.items].map((item) => item.slug),
          ["a", "b", "c"],
        );
      }),
  );

  it.effect(
    "/admin/organizations refuses limit=0, limit=201, limit=2.5 and cursor=garbage with 400",
    () =>
      Effect.gen(function* () {
        const { signInAs } = yield* buildHandler();
        const superadmin = yield* Effect.promise(() => signInAs("superadmin-1"));
        for (const query of ["limit=0", "limit=201", "limit=2.5", "cursor=garbage"]) {
          const response = yield* Effect.promise(() =>
            superadmin.request("GET", `/admin/organizations?${query}`),
          );
          assert.strictEqual(response.status, 400, query);
        }
      }),
  );

  it.effect("/admin/organizations answers 403 to a non-superadmin before any paging", () =>
    Effect.gen(function* () {
      const { signInAs, seedOrganizations } = yield* buildHandler();
      yield* Effect.promise(seedOrganizations);
      const ordinary = yield* Effect.promise(() => signInAs("ordinary-1"));
      const response = yield* Effect.promise(() => ordinary.request("GET", "/admin/organizations"));
      assert.strictEqual(response.status, 403);
      const limited = yield* Effect.promise(() =>
        ordinary.request("GET", "/admin/organizations?limit=1"),
      );
      assert.strictEqual(limited.status, 403);
    }),
  );

  it.effect("/admin/users bounds limit to 200: 201 is 400 and 200 is 200", () =>
    Effect.gen(function* () {
      const { signInAs } = yield* buildHandler();
      const superadmin = yield* Effect.promise(() => signInAs("superadmin-1"));
      const tooMany = yield* Effect.promise(() =>
        superadmin.request("GET", "/admin/users?limit=201"),
      );
      assert.strictEqual(tooMany.status, 400);
      const atMaximum = yield* Effect.promise(() =>
        superadmin.request("GET", "/admin/users?limit=200"),
      );
      assert.strictEqual(atMaximum.status, 200);
    }),
  );
});
