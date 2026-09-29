// BEH-EA-246 and 247 (spec/behaviors/30-scim.md), over real HTTP: bearer
// authentication, content types, the RFC 7644 wire shapes and error bodies, and the
// discovery documents — through `HttpRouter.toWebHandler`, the way a directory
// service's HTTP client would reach the plugin.
import { AuthHttp } from "@awthaq/server";
import { Errors, Sessions, Users } from "@awthaq/core";
import { Organization, OrganizationRecords } from "@awthaq/organization";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Scim from "../src/Scim.ts";
import * as ScimApi from "../src/ScimApi.ts";
import * as ScimConnections from "../src/ScimConnections.ts";
import * as ScimRecords from "../src/ScimRecords.ts";
import { ScimLive, seedConnection } from "./support.ts";

const ORIGIN = "http://localhost:3000";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const buildApp = (
  scimConfig: Partial<Scim.ScimConfigShape> = {},
  users: typeof Users.layerMemory = Users.layerMemory,
) => {
  const Live = ScimLive(scimConfig, {}, users);
  const AppLayer = AuthHttp.routes(ScimApi.ScimApi).pipe(
    Layer.provide(Live),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(AppLayer, { memoMap });
  /** Runs `effect` against the very same service instances the web handler uses. */
  const inside = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | Scim.Scim
      | ScimConnections.ScimConnectionStore
      | Organization.Organization
      | OrganizationRecords.OrganizationRecords
      | ScimRecords.ScimRecords
      | Users.Users
      | Sessions.Sessions
    >,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(Live, memoMap, scope);
          return yield* effect.pipe(Effect.provide(context));
        }),
      ),
    );
  return { handler, inside };
};

const call = (
  handler: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  options: { readonly token?: string; readonly body?: unknown; readonly contentType?: string } = {},
): Promise<Response> =>
  handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(options.body === undefined
          ? {}
          : { "content-type": options.contentType ?? "application/scim+json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );

const json = async (response: Response): Promise<Record<string, unknown>> => {
  const value: unknown = await response.json();
  return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
};

describe("SCIM over HTTP: authentication (BEH-EA-246)", () => {
  it.effect("a request without a token, with a wrong token, or with a malformed token is 401", () =>
    Effect.gen(function* () {
      const { handler } = buildApp();
      for (const token of [undefined, "scim_" + "0".repeat(64), "not-a-scim-token", ""]) {
        const response = yield* Effect.promise(() =>
          call(handler, "GET", "/scim/v2/Users", token === undefined ? {} : { token }),
        );
        assert.strictEqual(response.status, 401);
        const body = yield* Effect.promise(() => json(response));
        assert.strictEqual(body["status"], "401");
        assert.deepStrictEqual(body["schemas"], [ScimApi.ERROR_SCHEMA]);
      }
    }),
  );

  it.effect("a valid token reaches the resource and is scoped to its own connection", () =>
    Effect.gen(function* () {
      const { handler, inside } = buildApp();
      const okta = yield* Effect.promise(() => inside(seedConnection("Okta")));
      const entra = yield* Effect.promise(() => inside(seedConnection("Entra")));
      const created = yield* Effect.promise(() =>
        call(handler, "POST", "/scim/v2/Users", {
          token: okta.token,
          body: { userName: "ada@acme.example" },
        }),
      );
      assert.strictEqual(created.status, 201);
      const id = String((yield* Effect.promise(() => json(created)))["id"]);
      const own = yield* Effect.promise(() =>
        call(handler, "GET", `/scim/v2/Users/${id}`, { token: okta.token }),
      );
      assert.strictEqual(own.status, 200);
      const other = yield* Effect.promise(() =>
        call(handler, "GET", `/scim/v2/Users/${id}`, { token: entra.token }),
      );
      assert.strictEqual(other.status, 404);
    }),
  );

  it.effect("a revoked connection's token stops working immediately", () =>
    Effect.gen(function* () {
      const { handler, inside } = buildApp();
      const seeded = yield* Effect.promise(() => inside(seedConnection()));
      const before = yield* Effect.promise(() =>
        call(handler, "GET", "/scim/v2/Users", { token: seeded.token }),
      );
      assert.strictEqual(before.status, 200);
      yield* Effect.promise(() =>
        inside(
          Effect.flatMap(ScimConnections.ScimConnectionStore, (store) =>
            store.revoke(seeded.organizationId, seeded.connection.id),
          ),
        ),
      );
      const after = yield* Effect.promise(() =>
        call(handler, "GET", "/scim/v2/Users", { token: seeded.token }),
      );
      assert.strictEqual(after.status, 401);
    }),
  );
});

describe("SCIM over HTTP: what the token is checked against (BEH-EA-246)", () => {
  it.effect("only the token's hash is stored, and the hash is what authenticates", () =>
    Effect.gen(function* () {
      const { inside } = buildApp();
      const seeded = yield* Effect.promise(() => inside(seedConnection()));
      const stored = yield* Effect.promise(() =>
        inside(
          Effect.flatMap(ScimRecords.ScimRecords, (records) =>
            records.listConnections(seeded.organizationId),
          ),
        ),
      );
      assert.strictEqual(stored.length, 1);
      const [row] = stored;
      assert.isTrue(seeded.token.startsWith("scim_"));
      assert.notInclude(row?.tokenHash ?? "", seeded.token);
      assert.match(row?.tokenHash ?? "", /^[0-9a-f]{64}$/);
    }),
  );

  it.effect("a suspended organization's connection is refused like an unknown token, and works again once reinstated", () =>
    Effect.gen(function* () {
      const { handler, inside } = buildApp();
      const seeded = yield* Effect.promise(() => inside(seedConnection()));
      const setSuspended = (suspended: boolean) =>
        Effect.promise(() =>
          inside(
            Effect.gen(function* () {
              const orgs = yield* OrganizationRecords.OrganizationRecords;
              const now = yield* DateTime.now;
              yield* orgs.setSuspended(seeded.organizationId, suspended ? Option.some(now) : Option.none());
            }),
          ),
        );
      const status = () =>
        Effect.promise(() => call(handler, "GET", "/scim/v2/Users", { token: seeded.token })).pipe(
          Effect.map((response) => response.status),
        );
      assert.strictEqual(yield* status(), 200);
      yield* setSuspended(true);
      assert.strictEqual(yield* status(), 401);
      yield* setSuspended(false);
      assert.strictEqual(yield* status(), 200);
    }),
  );
});

describe("SCIM over HTTP: wire format (BEH-EA-252)", () => {
  it.effect("responses are application/scim+json; bodies are accepted as scim+json or plain json", () =>
    Effect.gen(function* () {
      const { handler, inside } = buildApp();
      const { token } = yield* Effect.promise(() => inside(seedConnection()));
      for (const [contentType, name] of [
        ["application/scim+json", "scim"],
        ["application/json", "plain"],
      ] as const) {
        const response = yield* Effect.promise(() =>
          call(handler, "POST", "/scim/v2/Users", {
            token,
            contentType,
            body: { userName: `${name}@acme.example`, active: true },
          }),
        );
        assert.strictEqual(response.status, 201);
        assert.include(response.headers.get("content-type") ?? "", "application/scim+json");
      }
    }),
  );

  it.effect("PATCH and DELETE work over HTTP: Okta's active:false, then 204", () =>
    Effect.gen(function* () {
      const { handler, inside } = buildApp();
      const { token } = yield* Effect.promise(() => inside(seedConnection()));
      const created = yield* Effect.promise(() =>
        call(handler, "POST", "/scim/v2/Users", { token, body: { userName: "ada@acme.example" } }),
      );
      const id = String((yield* Effect.promise(() => json(created)))["id"]);
      const patched = yield* Effect.promise(() =>
        call(handler, "PATCH", `/scim/v2/Users/${id}`, {
          token,
          contentType: "application/json",
          body: {
            schemas: [ScimApi.PATCH_SCHEMA],
            Operations: [{ op: "replace", value: { active: false } }],
          },
        }),
      );
      assert.strictEqual(patched.status, 200);
      assert.strictEqual((yield* Effect.promise(() => json(patched)))["active"], false);
      const deleted = yield* Effect.promise(() =>
        call(handler, "DELETE", `/scim/v2/Users/${id}`, { token }),
      );
      assert.strictEqual(deleted.status, 204);
    }),
  );

  it.effect("a list is a ListResponse; a filter names the resource; an unsupported filter is 400 invalidFilter", () =>
    Effect.gen(function* () {
      const { handler, inside } = buildApp();
      const { token } = yield* Effect.promise(() => inside(seedConnection()));
      yield* Effect.promise(() =>
        call(handler, "POST", "/scim/v2/Users", {
          token,
          body: { userName: "ada@acme.example", externalId: "dir-1" },
        }),
      );
      const listed = yield* Effect.promise(() =>
        call(handler, "GET", `/scim/v2/Users?filter=${encodeURIComponent('userName eq "ada@acme.example"')}&startIndex=1&count=10`, { token }),
      );
      assert.strictEqual(listed.status, 200);
      const body = yield* Effect.promise(() => json(listed));
      assert.deepStrictEqual(body["schemas"], [ScimApi.LIST_SCHEMA]);
      assert.strictEqual(body["totalResults"], 1);
      assert.strictEqual(body["startIndex"], 1);
      assert.isArray(body["Resources"]);
      const bad = yield* Effect.promise(() =>
        call(handler, "GET", `/scim/v2/Users?filter=${encodeURIComponent('name.familyName co "L"')}`, { token }),
      );
      assert.strictEqual(bad.status, 400);
      const error = yield* Effect.promise(() => json(bad));
      assert.strictEqual(error["scimType"], "invalidFilter");
      assert.strictEqual(error["status"], "400");
    }),
  );

  it.effect("conflicts are 409 with scimType uniqueness; unknown ids are 404 in the RFC error shape", () =>
    Effect.gen(function* () {
      const { handler, inside } = buildApp();
      const { token } = yield* Effect.promise(() => inside(seedConnection()));
      const body = { userName: "ada@acme.example" };
      yield* Effect.promise(() => call(handler, "POST", "/scim/v2/Users", { token, body }));
      const conflict = yield* Effect.promise(() =>
        call(handler, "POST", "/scim/v2/Users", { token, body }),
      );
      assert.strictEqual(conflict.status, 409);
      assert.strictEqual((yield* Effect.promise(() => json(conflict)))["scimType"], "uniqueness");
      const missing = yield* Effect.promise(() =>
        call(handler, "GET", "/scim/v2/Users/no-such-user", { token }),
      );
      assert.strictEqual(missing.status, 404);
      const error = yield* Effect.promise(() => json(missing));
      assert.deepStrictEqual(error["schemas"], [ScimApi.ERROR_SCHEMA]);
      assert.strictEqual(error["status"], "404");
    }),
  );

  it.effect("the discovery documents are served behind the token", () =>
    Effect.gen(function* () {
      const { handler, inside } = buildApp();
      const { token } = yield* Effect.promise(() => inside(seedConnection()));
      const config = yield* Effect.promise(() =>
        call(handler, "GET", "/scim/v2/ServiceProviderConfig", { token }),
      );
      assert.strictEqual(config.status, 200);
      const body = yield* Effect.promise(() => json(config));
      assert.deepStrictEqual(body["schemas"], [ScimApi.SERVICE_PROVIDER_CONFIG_SCHEMA]);
      assert.deepStrictEqual(body["patch"], { supported: true });
      const types = yield* Effect.promise(() => call(handler, "GET", "/scim/v2/ResourceTypes", { token }));
      assert.strictEqual(types.status, 200);
      const schemas = yield* Effect.promise(() => call(handler, "GET", "/scim/v2/Schemas", { token }));
      assert.strictEqual(schemas.status, 200);
      const anonymous = yield* Effect.promise(() =>
        call(handler, "GET", "/scim/v2/ServiceProviderConfig"),
      );
      assert.strictEqual(anonymous.status, 401);
    }),
  );

  it.effect("a group is created, read and deleted over HTTP", () =>
    Effect.gen(function* () {
      const { handler, inside } = buildApp();
      const { token } = yield* Effect.promise(() => inside(seedConnection()));
      const created = yield* Effect.promise(() =>
        call(handler, "POST", "/scim/v2/Groups", { token, body: { displayName: "Engineering" } }),
      );
      assert.strictEqual(created.status, 201);
      const id = String((yield* Effect.promise(() => json(created)))["id"]);
      const read = yield* Effect.promise(() =>
        call(handler, "GET", `/scim/v2/Groups/${id}`, { token }),
      );
      assert.strictEqual((yield* Effect.promise(() => json(read)))["displayName"], "Engineering");
      const deleted = yield* Effect.promise(() =>
        call(handler, "DELETE", `/scim/v2/Groups/${id}`, { token }),
      );
      assert.strictEqual(deleted.status, 204);
    }),
  );
});

/** The real in-memory `Users`, except that reading by email reports an outage. */
const UsersDownOnLookup: typeof Users.layerMemory = Layer.effect(
  Users.Users,
  Effect.gen(function* () {
    const real = yield* Users.Users;
    return Users.Users.of({
      ...real,
      findByEmail: () => Effect.fail(new Errors.StoreUnavailable({ operation: "Users.findByEmail" })),
    });
  }),
).pipe(Layer.provide(Users.layerMemory));

describe("SCIM over HTTP: a store outage (ADR-EA-028)", () => {
  it.effect("is a 503 with the RFC 7644 error body and none of the internal error's detail", () =>
    Effect.gen(function* () {
      const { handler, inside } = buildApp({}, UsersDownOnLookup);
      const seeded = yield* Effect.promise(() => inside(seedConnection()));
      const response = yield* Effect.promise(() =>
        call(handler, "POST", "/scim/v2/Users", {
          token: seeded.token,
          body: { userName: "ada@acme.example", emails: [{ value: "ada@acme.example", primary: true }] },
        }),
      );
      assert.strictEqual(response.status, 503);
      const body = yield* Effect.promise(() => json(response));
      assert.strictEqual(body["status"], "503");
      assert.deepStrictEqual(body["schemas"], [ScimApi.ERROR_SCHEMA]);
      assert.strictEqual(body["_tag"], "ScimUnavailable");
      assert.notInclude(JSON.stringify(body), "Users.findByEmail");
      assert.notInclude(JSON.stringify(body), "StoreUnavailable");
    }),
  );
});
