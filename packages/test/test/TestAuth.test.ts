// spec/behaviors/25-testing-harness.md, BEH-EA-193, BEH-EA-197.
//
// A small companion plugin (`Whoami`) exercises `TestAuth.layer` end to end
// against something requiring real `Api.Authentication` — proving the whole
// memory pipeline (`Users`/`Sessions` real, shared instances, not
// independently re-created ones) actually wires together for a real plugin,
// and that `signInAs`'s cookie really authenticates a subsequent request.
//
// `Authentication.AuthenticationLive` is passed as `TestAuth.layer`'s own
// `services` argument (not merged in afterward) — see that function's own
// doc comment for why any other composition fails to type-check.
// `@effect/vitest`'s own `layer(...)` builds the runtime once (only a
// genuinely closed layer — `RIn` really `never` — type-checks here) and
// shares it across every `it.effect` below — dispatching each request
// through the *ambient* `HttpRouter` service directly (`router.asHttpEffect()`)
// rather than a fresh `HttpRouter.toWebHandler(TestLayer)` per call, since
// the latter would rebuild the whole layer independently each time — a
// second, unrelated `Users`/`Sessions` instance `signInAs`'s own session
// would never be visible to.
import { Api } from "@awthaq/api";
import { Auth, AuthPlugin, Users } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { Authentication, Csrf } from "@awthaq/server";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as TestAuth from "../src/TestAuth.ts";

class Whoami extends Schema.Class<Whoami>("Whoami")({ userId: Schema.String }) {}

const WhoamiApi = HttpApi.make("auth").add(
  HttpApiGroup.make("whoami")
    .add(HttpApiEndpoint.get("get", "/whoami", { success: Whoami }))
    .middleware(Api.Authentication),
);

const WhoamiHandlers = HttpApiBuilder.group(WhoamiApi, "whoami", (handlers) =>
  handlers.handle("get", () =>
    Effect.gen(function* () {
      const principal = yield* Api.CurrentPrincipal;
      if (principal._tag !== "User") {
        return yield* Effect.die(new Error("expected a User principal"));
      }
      return new Whoami({ userId: principal.ref.id });
    }),
  ),
);

class WhoamiPlugin extends AuthPlugin.Service<WhoamiPlugin, Record<string, never>>()("whoami", {
  apiVersion: 1,
  contract: WhoamiApi,
  tables: [],
}) {
  static readonly layer = AuthPlugin.layer(WhoamiPlugin, {
    make: Effect.succeed({}),
    handlers: WhoamiHandlers,
  });
}

const built = Auth.make([WhoamiPlugin]);

const TestLayer = TestAuth.layer(
  built,
  Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
);

const dispatch = (request: Request) =>
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const serverRequest = HttpServerRequest.fromWeb(request);
    const response = yield* router
      .asHttpEffect()
      .pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, serverRequest),
        Effect.scoped,
      );
    return HttpServerResponse.toWeb(response);
  });

layer(TestLayer)("TestAuth.layer (BEH-EA-193)", (it) => {
  it.effect("BEH-EA-197: signInAs mints a real session, authenticating a subsequent request", () =>
    Effect.gen(function* () {
      const signedIn = yield* TestAuth.signInAs({ email: "member@example.com" });
      const response = yield* dispatch(
        new Request("http://localhost/whoami", {
          headers: { cookie: signedIn.cookieHeader },
        }),
      );
      assert.strictEqual(response.status, 200);
      const body = (yield* Effect.promise(() => response.json())) as { userId: string };
      assert.strictEqual(body.userId, signedIn.userId);
    }),
  );

  it.effect("with no credential, the same endpoint answers 401 Unauthenticated", () =>
    Effect.gen(function* () {
      const response = yield* dispatch(new Request("http://localhost/whoami"));
      assert.strictEqual(response.status, 401);
    }),
  );

  it.effect("BEH-EA-197: onSignedUp runs before the session is issued", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const signedIn = yield* TestAuth.signInAs({
        email: "with-callback@example.com",
        onSignedUp: (userId) => Effect.sync(() => seen.push(userId)),
      });
      assert.deepStrictEqual(seen, [signedIn.userId]);
    }),
  );
});

// ETVS-004: the memory bundle is complete for a password-style composition — `Verification`
// and a (low-cost, real) `PasswordHasher` ride in it, so a suite passes only the layers that
// are genuinely its own (`Authentication`, `CsrfProtection`, an `HttpClient` for the breach
// check) in `services`, never a second `Verification`/`PasswordHasher`.
const PasswordLayer = TestAuth.layer(
  Auth.make([Password.Password]),
  Layer.mergeAll(
    Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
    Csrf.CsrfProtectionLive.pipe(
      Layer.provide(
        Layer.succeed(Csrf.CsrfConfig, {
          secret: Redacted.make("test-auth-memory-bundle-csrf-secret-32-bytes!!"),
          allowedOrigins: [],
        }),
      ),
    ),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(`${"F".repeat(35)}:1`, { status: 200 })),
        ),
      ),
    ),
  ),
);

layer(PasswordLayer)("TestAuth.layer — the memory bundle serves Password with no extra layers", (it) => {
  it.effect("signUp then signIn work with only Authentication, CSRF and an HttpClient supplied", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const users = yield* Users.Users;
      const secret = Redacted.make("a sufficiently long test password");
      const issued = yield* password.signUp({ email: "bundle@example.com", password: secret });
      yield* users.verifyEmail(issued.session.userId);
      const again = yield* password.signIn({ email: "bundle@example.com", password: secret });
      assert.strictEqual(again.session.userId, issued.session.userId);
    }),
  );
});
