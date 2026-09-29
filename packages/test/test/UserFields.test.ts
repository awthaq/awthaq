// SAM-004 acceptance: "A plugin can declare a typed user field end-to-end (migration, storage, typed
// read/write, client type) without touching core source." A toy `Billing` plugin declares two fields; a
// `TestAuth` composition of it serves the real `PATCH /user` over memory, `Users.typedFields` reads and
// writes them typed, and the client encodes only what the composition lets a client write.
import { Api } from "@awthaq/api";
import { Auth, AuthPlugin, UserFields, Users } from "@awthaq/core";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, layer } from "@effect/vitest";
import { createHmac, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as TestAuth from "../src/TestAuth.ts";

const BillingApi = HttpApi.make("auth").add(
  HttpApiGroup.make("billing").add(
    HttpApiEndpoint.get("plan", "/billing/plan", { success: Schema.String }),
  ),
);

class Billing extends AuthPlugin.Service<Billing, Record<string, never>>()("billing", {
  apiVersion: 1,
  contract: BillingApi,
  userFields: {
    plan: UserFields.serverOnly(Schema.Literals(["free", "pro"])),
    nickname: UserFields.field(Schema.String),
  },
}) {
  static readonly layer = AuthPlugin.layer(Billing, {
    make: Effect.succeed({}),
    handlers: HttpApiBuilder.group(BillingApi, "billing", (handlers) =>
      handlers.handle("plan", () => Effect.succeed("free")),
    ),
  });
}

const built = Auth.make([Billing]);

const CSRF_SECRET = "test-auth-user-fields-csrf-secret-padded-to-32-bytes";
// The router runs under `it.effect`'s TestClock, which starts at 0 (`<iat>.<random>.<hmac>`).
const CSRF_COOKIE = (() => {
  const signed = `0.${randomBytes(32).toString("hex")}`;
  return `${signed}.${createHmac("sha256", CSRF_SECRET).update(signed).digest("hex")}`;
})();

const TestLayer = TestAuth.layer(
  built,
  Layer.mergeAll(
    Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
    Csrf.CsrfProtectionLive.pipe(
      Layer.provide(
        Layer.succeed(Csrf.CsrfConfig, {
          secret: Redacted.make(CSRF_SECRET),
          allowedOrigins: [] as ReadonlyArray<string>,
        }),
      ),
      Layer.provide(NodeCrypto.layer),
    ),
  ),
);

const dispatch = (request: Request) =>
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const response = yield* router
      .asHttpEffect()
      .pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
        Effect.scoped,
      );
    return HttpServerResponse.toWeb(response);
  });

layer(TestLayer)("a plugin-declared user field, end to end (SAM-004)", (it) => {
  it.effect("declares, stores, gates, reads typed and encodes for the client without core changes", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const signedIn = yield* TestAuth.signInAs({ email: "ada@example.com" });
      const billing = Users.typedFields(built.userFields);
      const profile = UserFields.client(built.userFields);

      // Trusted server code sets the system-authority field, typed.
      yield* billing.set(signedIn.userId, { billing_plan: "pro" });

      // The client sends only what the types let it (`billing_plan` would not compile in `encode`).
      const wire = yield* profile.encode({ billing_nickname: "Countess" });
      const patch = (fields: Readonly<Record<string, unknown>>) =>
        dispatch(
          new Request("http://localhost/user", {
            method: "PATCH",
            headers: {
              cookie: `${signedIn.cookieHeader}; ${Api.CSRF_COOKIE_NAME}=${CSRF_COOKIE}`,
              [Api.CSRF_HEADER_NAME]: CSRF_COOKIE,
              "content-type": "application/json",
            },
            body: JSON.stringify({ name: "Ada", fields }),
          }),
        );
      const ok = yield* patch(wire);
      assert.strictEqual(ok.status, 200);
      const dto = (yield* Effect.promise(() => ok.json())) as { fields: Record<string, string> };
      const seen = yield* profile.decode(dto.fields);
      assert.strictEqual(seen.billing_plan, "pro");
      assert.strictEqual(seen.billing_nickname, "Countess");

      // A hand-built payload that names the server-only field is refused, and nothing changes.
      const forbidden = yield* patch({ billing_plan: "free" });
      assert.strictEqual(forbidden.status, 403);
      assert.strictEqual((yield* billing.get(signedIn.userId)).billing_plan, "pro");
      assert.deepStrictEqual(yield* users.getFields(signedIn.userId), {
        billing_plan: "pro",
        billing_nickname: "Countess",
      });
    }),
  );
});
