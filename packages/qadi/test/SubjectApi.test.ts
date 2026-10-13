// A real `HttpRouter.toWebHandler` test of `SubjectApi.ts`'s "whoami"
// contract, the same harness shape `AuthorizedSubject.test.ts` already uses
// (a tiny `/login` endpoint mints a real session cookie the second request
// carries) — proving the real, exported `SubjectApi`/`SubjectHandlers`
// actually serve a decodable `SubjectDto`, not just that the underlying
// `AuthorizedSubject` middleware chain resolves a subject in memory.
import { SubjectContract } from "@awthaq/api";
import { Auth, SessionCookie, Sessions, Users } from "@awthaq/core";
import { AuthHttp } from "@awthaq/server";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as AuthorizedSubject from "../src/AuthorizedSubject.ts";
import * as Resolvers from "../src/Resolvers.ts";
import * as SubjectApi from "../src/SubjectApi.ts";
import * as UserClaims from "../src/UserClaims.ts";
import { TestAuth } from "@awthaq/test";

// The real, shipped `SubjectApi.SubjectGroup`/`SubjectHandlers` exactly as `@awthaq/react` consumes them, plus a tiny
// `/login` group of the test's own (it mints a real session cookie the second request carries), both riding as
// `extraGroups` beside the `UserClaims` plugin through the composition a host builds. `HttpApiBuilder.group`'s
// handler tag is keyed by the composed api's id, so the login group is declared against `auth`.
const LoginGroup = HttpApiGroup.make("login").add(
  HttpApiEndpoint.post("login", "/login", { success: Schema.Void }),
);
const LoginApi = HttpApi.make("auth").add(LoginGroup);

const LoginHandlers = HttpApiBuilder.group(
  LoginApi,
  "login",
  Effect.fnUntraced(function* (handlers) {
    const sessions = yield* Sessions.Sessions;
    const users = yield* Users.Users;
    return handlers.handleAll({
      login: Effect.fnUntraced(function* () {
        const user = yield* users
          .create({
            identity: { _tag: "Email", email: "subject-api@example.com" },
            name: "Subject Api",
          })
          .pipe(Effect.orDie);
        const { token, session } = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
        yield* SessionCookie.set(session, token);
      }),
    });
  }),
);

const built = Auth.make([UserClaims.UserClaims], {
  extraGroups: [SubjectApi.SubjectGroup, LoginGroup],
});

const handlers = Layer.mergeAll(SubjectApi.SubjectHandlers, LoginHandlers).pipe(
  Layer.provideMerge(AuthorizedSubject.AuthorizedSubjectLive),
);

const AppLayer = TestAuth.layer(built, { services: handlers });

// AAPS-008: the same real app, but the operator exposes one resolver-backed
// attribute; `UserAttributes` answers it (and memoizes the user per request).
const ExposingLayer = TestAuth.layer(built, {
  services: Layer.mergeAll(
    handlers,
    Resolvers.UserAttributes,
    SubjectApi.config(["emailVerified"]),
  ),
});

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
        const { handler } = TestAuth.app(ExposingLayer);
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
      const { handler } = TestAuth.app(AppLayer);
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
      const { handler } = TestAuth.app(ExposingLayer);
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
      const { handler } = TestAuth.app(AppLayer);
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
        const { handler } = TestAuth.app(AppLayer);
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
    assert.deepStrictEqual(Object.keys(built.api.groups).sort(), [
      "account",
      "login",
      "session",
      "subject",
    ]);
    // Typed, not just runtime: the group's handler service is keyed by the composed api's own id.
    const routes = AuthHttp.routes(built.api, {}).pipe(Layer.provide(SubjectApi.SubjectHandlers));
    assert.isDefined(routes);
  });
});
