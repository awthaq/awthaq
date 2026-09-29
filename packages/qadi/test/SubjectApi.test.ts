// A real `HttpRouter.toWebHandler` test of `SubjectApi.ts`'s "whoami"
// contract, the same harness shape `AuthorizedSubject.test.ts` already uses
// (a tiny `/login` endpoint mints a real session cookie the second request
// carries) — proving the real, exported `SubjectApi`/`SubjectHandlers`
// actually serve a decodable `SubjectDto`, not just that the underlying
// `AuthorizedSubject` middleware chain resolves a subject in memory.
import { SubjectContract } from "@awthaq/api";
import { Auth, AuditLog, Hooks, AuthEvents, SessionCookie, Sessions, Users } from "@awthaq/core";
import { Authentication, AuthHttp } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as AuthorizedSubject from "../src/AuthorizedSubject.ts";
import * as Resolvers from "../src/Resolvers.ts";
import * as SubjectApi from "../src/SubjectApi.ts";
import * as UserClaims from "../src/UserClaims.ts";

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
      const { token, session } = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
      yield* SessionCookie.set(session, token);
    }),
  }),
);

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(Users.layerMemory, Sessions.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
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

// AAPS-008: the same real app, but the operator exposes one resolver-backed
// attribute; `UserAttributes` answers it (and memoizes the user per request).
const ExposingLayer = Layer.mergeAll(
  AuthHttp.routes(SubjectApi.SubjectApi, {}).pipe(
    Layer.provide(SubjectApi.SubjectHandlers),
    Layer.provide(AuthorizedSubject.AuthorizedSubjectLive),
    Layer.provide(Authentication.OptionalAuthenticationLive),
    Layer.provide(Authentication.PrincipalResolverLive),
  ),
  AuthHttp.routes(LoginApi, {}).pipe(Layer.provide(LoginHandlers)),
).pipe(
  Layer.provideMerge(Resolvers.UserAttributes),
  Layer.provideMerge(SubjectApi.config(["emailVerified"])),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(TestServices),
  Layer.provideMerge(HttpRouter.layer),
);

const loginCookie = (handler: (request: Request) => Promise<Response>) =>
  Effect.promise(async () => {
    const response = await handler(new Request("http://localhost/login", { method: "POST" }));
    return response.headers.get("set-cookie")?.split(";")[0] ?? "";
  });

describe("SubjectApi exposedAttributes (AAPS-008)", () => {
  it.effect(
    "an exposed resolver-backed attribute appears in GET /subject, unexposed ones do not",
    () =>
      Effect.gen(function* () {
        const { handler } = HttpRouter.toWebHandler(ExposingLayer);
        const cookie = yield* loginCookie(handler);
        const response = yield* Effect.promise(() =>
          handler(new Request("http://localhost/subject", { headers: { cookie } })),
        );
        assert.strictEqual(response.status, 200);
        const dto = Schema.decodeUnknownSync(SubjectContract.SubjectDto)(
          yield* Effect.promise(() => response.json()),
        );
        assert.strictEqual(dto.attributes["emailVerified"], false);
        // `email`/`name` are resolver-backed too, but the operator did not name them.
        assert.notProperty(dto.attributes, "email");
        assert.notProperty(dto.attributes, "name");
      }),
  );

  it.effect("by default (nothing exposed) no resolver-backed attribute reaches the client", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);
      const cookie = yield* loginCookie(handler);
      const response = yield* Effect.promise(() =>
        handler(new Request("http://localhost/subject", { headers: { cookie } })),
      );
      const dto = Schema.decodeUnknownSync(SubjectContract.SubjectDto)(
        yield* Effect.promise(() => response.json()),
      );
      assert.notProperty(dto.attributes, "emailVerified");
    }),
  );

  it.effect("exposing an attribute for an anonymous caller resolves to nothing, not an error", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(ExposingLayer);
      const response = yield* Effect.promise(() =>
        handler(new Request("http://localhost/subject")),
      );
      assert.strictEqual(response.status, 200);
      const dto = Schema.decodeUnknownSync(SubjectContract.SubjectDto)(
        yield* Effect.promise(() => response.json()),
      );
      assert.notProperty(dto.attributes, "emailVerified");
    }),
  );
});

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

describe("SubjectApi through Auth.make extraGroups (MW-002)", () => {
  it("the subject group joins the one composed api, and SubjectHandlers satisfy it", () => {
    const built = Auth.make([UserClaims.UserClaims], { extraGroups: [SubjectApi.SubjectGroup] });
    assert.deepStrictEqual(Object.keys(built.api.groups).sort(), ["account", "session", "subject"]);
    // Typed, not just runtime: the group's handler service is keyed by the composed api's own id.
    const routes = AuthHttp.routes(built.api, {}).pipe(Layer.provide(SubjectApi.SubjectHandlers));
    assert.isDefined(routes);
  });
});
