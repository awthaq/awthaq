// P20a: two defects the BDD wiring of 30-scim.feature exposed.
//   - BEH-EA-250: a `beforeDelete` veto (a legal hold) must leave the user exactly as it was;
//     the erase path revoked the user's sessions and dropped the connection's mapping *before*
//     asking, so a refused DELETE still logged the user out and hid it from the directory.
//   - BEH-EA-252: `/ServiceProviderConfig` must report the `filter.maxResults` the plugin
//     actually enforces (`ScimConfig.maxResults`), not a hard-coded 200.
import { Hooks, HookPoint, Sessions, Users } from "@awthaq/core";
import { AuthHttp } from "@awthaq/server";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Scim from "../src/Scim.ts";
import * as ScimApi from "../src/ScimApi.ts";
import { ScimLive, seedConnection } from "./support.ts";

const LegalHold = Hooks.BeforeUserDelete.tap(() =>
  Effect.fail(new HookPoint.HookAbort({ code: "LEGAL_HOLD" })),
).pipe(Layer.provideMerge(Hooks.HooksLive));

describe("SCIM DELETE with erasure configured (BEH-EA-250)", () => {
  it.effect("a beforeDelete veto is a 403 that leaves the user, its sessions and its mapping in place", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const created = yield* scim.createUser(connection, { userName: "ada@acme.example" });
      const id = Users.UserId(created.id);
      const session = yield* sessions.issue({ userId: id });

      const refused = yield* scim.deleteUser(connection, created.id).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "ScimForbidden");

      assert.strictEqual((yield* users.findById(id)).status, "active");
      assert.strictEqual((yield* sessions.verify(session.token)).session.userId, id);
      // Still the connection's user: the refused erasure did not orphan it from its directory.
      assert.isTrue((yield* scim.getUser(connection, created.id)).active);
      assert.strictEqual((yield* scim.listUsers(connection, {})).totalResults, 1);
    }).pipe(
      Effect.provide(ScimLive({ deleteBehavior: "erase" }, {}, Users.layerMemory, LegalHold)),
    ),
  );
});

describe("SCIM ServiceProviderConfig (BEH-EA-252)", () => {
  it.effect("reports the configured maximum page size as the filter's maxResults", () =>
    Effect.gen(function* () {
      const Live = ScimLive({ maxResults: 50 });
      const AppLayer = AuthHttp.routes(ScimApi.ScimApi).pipe(
        Layer.provide(Live),
        Layer.provideMerge(
          Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
            Layer.provideMerge(FileSystem.layerNoop({})),
          ),
        ),
        Layer.provideMerge(HttpRouter.layer),
      );
      const memoMap = Layer.makeMemoMapUnsafe();
      const { handler } = HttpRouter.toWebHandler(AppLayer, { memoMap });
      const { token } = yield* Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(Live, memoMap, scope);
          return yield* seedConnection().pipe(Effect.provide(context));
        }),
      );
      const response = yield* Effect.promise(() =>
        handler(
          new Request("http://localhost:3000/scim/v2/ServiceProviderConfig", {
            headers: { authorization: `Bearer ${token}` },
          }),
        ),
      );
      assert.strictEqual(response.status, 200);
      const body: unknown = yield* Effect.promise(() => response.json());
      assert.deepStrictEqual(
        typeof body === "object" && body !== null && "filter" in body ? body.filter : undefined,
        { supported: true, maxResults: 50 },
      );
    }),
  );
});
