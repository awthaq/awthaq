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
import { AuditLog, AuthEvents, Sessions, Users } from "@awthaq/core";
import { Authentication, AuthHttp } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { CurrentSubject } from "@qadi/core";
import * as AuthorizedSubject from "../src/AuthorizedSubject.ts";

class Whoami extends Schema.Class<Whoami>("Whoami")({ subjectId: Schema.String }) {}

const WhoamiGroup = HttpApiGroup.make("whoami")
  .add(HttpApiEndpoint.post("login", "/login", { success: Schema.Void }))
  .add(HttpApiEndpoint.get("get", "/whoami", { success: Whoami }))
  .middleware(AuthorizedSubject.AuthorizedSubject)
  .middleware(Api.OptionalAuthentication);

const TestApi = HttpApi.make("auth").add(WhoamiGroup);

const WhoamiHandlers = HttpApiBuilder.group(TestApi, "whoami", (handlers) =>
  handlers.handleAll({
    login: Effect.fnUntraced(function* () {
      const sessions = yield* Sessions.Sessions;
      const users = yield* Users.Users;
      const user = yield* users
        .create({ email: "whoami@example.com", name: "Whoami" })
        .pipe(Effect.orDie);
      const { token } = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
      yield* HttpApiBuilder.securitySetCookie(
        Api.SessionCookie,
        Redacted.value(token),
        Sessions.SESSION_COOKIE_ATTRIBUTES,
      );
    }),
    get: Effect.fnUntraced(function* () {
      const subject = yield* CurrentSubject;
      return new Whoami({ subjectId: subject.id });
    }),
  }),
);

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(Users.layerMemory, Sessions.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(NodeCrypto.layer),
);

const AppLayer = AuthHttp.routes(TestApi, {}).pipe(
  Layer.provide(WhoamiHandlers),
  Layer.provide(AuthorizedSubject.AuthorizedSubjectLive),
  Layer.provide(Authentication.OptionalAuthenticationLive),
  Layer.provide(Authentication.PrincipalResolverLive),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(TestServices),
  Layer.provideMerge(HttpRouter.layer),
);

describe("AuthorizedSubject (real HTTP)", () => {
  it.effect("BEH-EA-145: with no credential, the handler sees qadi's anonymous subject", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);
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
        const { handler } = HttpRouter.toWebHandler(AppLayer);
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
