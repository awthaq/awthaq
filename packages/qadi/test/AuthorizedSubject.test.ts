// spec/behaviors/19-qadi-bridge-path-a.md, BEH-EA-145.
//
// A real `HttpRouter.toWebHandler` test, the same shape
// `@awthaq/password`/`@awthaq/oauth`'s own `AuthHttp.test.ts` use:
// domain-level tests (`SubjectResolver.test.ts`) prove the resolver logic in
// isolation, but only a real request through a real `.middleware(Authentication)
// .middleware(AuthorizedSubject)` chain proves the bridge is actually wired —
// that `CurrentPrincipal` really is available by the time `AuthorizedSubject`
// runs, and that a handler really does receive qadi's `CurrentSubject`.
//
// A tiny `/login` endpoint (calling `Sessions.issue`/`Users.create` directly,
// the way `AuthHttp.test.ts` files elsewhere in this repo mint a session out
// of band) issues the real cookie the second request then carries — a
// single `HttpRouter.toWebHandler(AppLayer)` runtime is built once and
// reused for both requests, since each independent build would otherwise
// own its own, unrelated `Sessions`/`Users` state.
import { Api } from "@awthaq/api";
import { Auth, AuthPlugin, SessionCookie, Sessions, Users } from "@awthaq/core";
import { assert, describe, expectTypeOf, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { CurrentSubject } from "@qadi/core";
import * as AuthorizedSubject from "../src/AuthorizedSubject.ts";
import { TestAuth } from "@awthaq/test";

class Whoami extends Schema.Class<Whoami>("Whoami")({ subjectId: Schema.String }) {}

const WhoamiGroup = HttpApiGroup.make("whoami")
  .add(HttpApiEndpoint.post("login", "/login", { success: Schema.Void }))
  .add(HttpApiEndpoint.get("get", "/whoami", { success: Whoami }))
  .middleware(AuthorizedSubject.AuthorizedSubject)
  .middleware(Api.OptionalAuthentication);

const TestApi = HttpApi.make("auth").add(WhoamiGroup);

const WhoamiHandlers = HttpApiBuilder.group(
  TestApi,
  "whoami",
  Effect.fnUntraced(function* (handlers) {
    const sessions = yield* Sessions.Sessions;
    const users = yield* Users.Users;
    return handlers.handleAll({
      login: Effect.fnUntraced(function* () {
        const user = yield* users
          .create({ identity: { _tag: "Email", email: "whoami@example.com" }, name: "Whoami" })
          .pipe(Effect.orDie);
        const { token, session } = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
        yield* SessionCookie.set(session, token);
      }),
      get: Effect.fnUntraced(function* () {
        const subject = yield* CurrentSubject;
        return new Whoami({ subjectId: subject.id });
      }),
    });
  }),
);

/** A one-group plugin: the bridge is exercised through the composition a host builds (`TestAuth.layer`), not a hand-wired router. */
class WhoamiPlugin extends AuthPlugin.Service<WhoamiPlugin, Record<string, never>>()("whoami", {
  apiVersion: 1,
  contract: TestApi,
  tables: {},
}) {
  static readonly layer = AuthPlugin.layer(WhoamiPlugin, {
    make: Effect.succeed({}),
    handlers: WhoamiHandlers,
  });
}

const AppLayer = TestAuth.layer(Auth.make([WhoamiPlugin]), {
  services: AuthorizedSubject.AuthorizedSubjectLive,
});

describe("AuthorizedSubject (real HTTP)", () => {
  it.effect("BEH-EA-145: with no credential, the handler sees qadi's anonymous subject", () =>
    Effect.gen(function* () {
      const { handler } = TestAuth.app(AppLayer);
      const response = yield* Effect.promise(() => handler(new Request("http://localhost/whoami")));
      assert.strictEqual(response.status, 200);
      const body = (yield* Effect.promise(() => response.json())) as { subjectId: string };
      assert.strictEqual(body.subjectId, "anonymous");
    }),
  );

  it.effect(
    "BEH-EA-145: with a real session cookie, the handler sees the user's own subject id",
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

        const whoamiResponse = yield* Effect.promise(() =>
          handler(
            new Request("http://localhost/whoami", { headers: { cookie: cookieValue ?? "" } }),
          ),
        );
        assert.strictEqual(whoamiResponse.status, 200);
        const body = (yield* Effect.promise(() => whoamiResponse.json())) as {
          subjectId: string;
        };
        assert.match(body.subjectId, /^user:/);
      }),
  );
});

// YL-008: the helper applies the pair in the one order that works, and the type
// system objects to the other order (an unsatisfied `CurrentPrincipal`).
describe("withAuthorizedSubject (YL-008)", () => {
  const base = HttpApiGroup.make("typed").add(
    HttpApiEndpoint.get("get", "/typed", { success: Whoami }),
  );
  const viaHelper = AuthorizedSubject.withAuthorizedSubject(base);
  const misordered = base
    .middleware(Api.Authentication)
    .middleware(AuthorizedSubject.AuthorizedSubject);
  const handRolled = base
    .middleware(AuthorizedSubject.AuthorizedSubject)
    .middleware(Api.Authentication);

  it("leaves no unsatisfied middleware service, exactly like the hand-ordered pair", () => {
    expectTypeOf<HttpApiGroup.MiddlewareServices<typeof viaHelper>>().toEqualTypeOf<never>();
    expectTypeOf<HttpApiGroup.MiddlewareServices<typeof handRolled>>().toEqualTypeOf<never>();
  });

  it("the reversed order leaves CurrentPrincipal unsatisfied", () => {
    expectTypeOf<HttpApiGroup.MiddlewareServices<typeof misordered>>().not.toEqualTypeOf<never>();
    expectTypeOf<Api.CurrentPrincipal>().toExtend<
      HttpApiGroup.MiddlewareServices<typeof misordered>
    >();
  });
});
