// A real `HttpRouter.toWebHandler` test of `SubjectApi.ts`'s "whoami"
// contract, the same harness shape `AuthorizedSubject.test.ts` already uses
// (a tiny `/login` endpoint mints a real session cookie the second request
// carries) — proving the real, exported `SubjectApi`/`SubjectHandlers`
// actually serve a decodable `SubjectDto`, not just that the underlying
// `AuthorizedSubject` middleware chain resolves a subject in memory.
import { Api } from "@awthaq/api";
import { AuthEvents, Sessions, Users } from "@awthaq/core";
import { Authentication, AuthHttp } from "@awthaq/server";
import { NodeCrypto } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { AuthorizedSubject, SubjectApi } from "../src/index.ts";

// A separate, standalone tiny `HttpApi` (its own id, its own group) rather
// than folding a `/login` endpoint into `SubjectApi.SubjectApi` itself —
// this test exercises the real, shipped `SubjectApi.SubjectApi`/
// `SubjectHandlers` exactly as `@awthaq/react` will consume them, not
// a test-local variant with a different api id (`HttpApiBuilder.group`'s
// generated handler-registration tag is keyed by the owning api's id, so a
// handlers `Layer` built against one api id cannot satisfy a differently-
// named combined api expecting the same group under its own id).
// `AuthHttp.routes` for each app contributes routes to the same ambient
// `HttpRouter.layer`, the same way `AuthHttp.test.ts` combines
// `AuthHttp.routes(...)` and `AuthHttp.docs(...)` for one api.
const LoginGroup = HttpApiGroup.make("login").add(
  HttpApiEndpoint.post("login", "/login", { success: Schema.Void }),
);
const LoginApi = HttpApi.make("subject-api-test-login").add(LoginGroup);

const LoginHandlers = HttpApiBuilder.group(LoginApi, "login", (handlers) =>
  handlers.handleAll({
    login: Effect.fnUntraced(function* () {
      const sessions = yield* Sessions.Sessions;
      const users = yield* Users.Users;
      const user = yield* users
        .create({ email: "subject-api@example.com", name: "Subject Api" })
        .pipe(Effect.orDie);
      const { token } = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
      yield* HttpApiBuilder.securitySetCookie(
        Api.SessionCookie,
        Redacted.value(token),
        Sessions.SESSION_COOKIE_ATTRIBUTES,
      );
    }),
  }),
);

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(Users.layerMemory, Sessions.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const AppLayer = Layer.mergeAll(
  AuthHttp.routes(SubjectApi.SubjectApi, {}).pipe(
    Layer.provide(SubjectApi.SubjectHandlers),
    Layer.provide(AuthorizedSubject.AuthorizedSubjectLive),
    Layer.provide(Authentication.OptionalAuthenticationLive),
    Layer.provide(Authentication.PrincipalResolverLive),
  ),
  AuthHttp.routes(LoginApi, {}).pipe(Layer.provide(LoginHandlers)),
).pipe(
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(TestServices),
  Layer.provideMerge(HttpRouter.layer),
);

describe("SubjectApi (real HTTP)", () => {
  it.effect("BEH-EA-179: with no credential, /subject resolves qadi's anonymous subject", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);
      const response = yield* Effect.promise(() =>
        handler(new Request("http://localhost/subject")),
      );
      assert.strictEqual(response.status, 200);
      const body = (yield* Effect.promise(() => response.json())) as {
        id: string;
        roles: ReadonlyArray<string>;
        permissions: ReadonlyArray<string>;
        attributes: Readonly<Record<string, unknown>>;
      };
      assert.strictEqual(body.id, "anonymous");
      assert.deepStrictEqual(body.roles, []);
      assert.deepStrictEqual(body.permissions, []);
    }),
  );

  it.effect(
    "BEH-EA-179: with a real session cookie, /subject resolves the user's own subject id",
    () =>
      Effect.gen(function* () {
        const { handler } = HttpRouter.toWebHandler(AppLayer);
        const loginResponse = yield* Effect.promise(() =>
          handler(new Request("http://localhost/login", { method: "POST" })),
        );
        const cookie = loginResponse.headers.get("set-cookie");
        if (cookie === null) {
          throw new Error("expected /login to set a session cookie");
        }
        const cookieValue = cookie.split(";")[0];

        const subjectResponse = yield* Effect.promise(() =>
          handler(
            new Request("http://localhost/subject", { headers: { cookie: cookieValue ?? "" } }),
          ),
        );
        assert.strictEqual(subjectResponse.status, 200);
        const body = (yield* Effect.promise(() => subjectResponse.json())) as { id: string };
        assert.match(body.id, /^user:/);
      }),
  );
});
