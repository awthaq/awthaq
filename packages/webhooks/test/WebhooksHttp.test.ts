// BEH-EA-281 (spec/behaviors/34-webhooks.md), over real HTTP: the admin group behind the admin-tier
// authentication and CSRF, the fail-closed gate, the secret shown once on the wire, and the typed errors.
import { Api } from "@awthaq/api";
import { Sessions, Users } from "@awthaq/core";
import { AuthHttp, Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { createHmac, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Webhooks from "../src/Webhooks.ts";
import * as WebhooksApi from "../src/WebhooksApi.ts";
import { deliveryLayer } from "./support.ts";

const CSRF_TEST_SECRET = "webhooks-authhttp-test-csrf-secret-padded-to-32-bytes";

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make(CSRF_TEST_SECRET),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

// `<iat>.<random>.<hmac(iat.random)>`, computed independently of `Csrf.ts` with `node:crypto`.
const CSRF_VALUE: string = (() => {
  const signed = `${Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  return `${signed}.${createHmac("sha256", CSRF_TEST_SECRET).update(signed).digest("hex")}`;
})();

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const AdminAuthenticationLive = Authentication.AdminAuthenticationLive.pipe(
  Layer.provide(
    Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
  ),
);

const ORIGIN = "http://localhost:3000";

const build = (config: Partial<Webhooks.WebhooksConfigShape>) => {
  const AppLayer = AuthHttp.routes(WebhooksApi.WebhooksApi).pipe(
    Layer.provide(Webhooks.Webhooks.layer),
    Layer.provide(AdminAuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(deliveryLayer({ config })),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(AppLayer, { memoMap });
  const sessionCookie = (): Promise<string> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(AppLayer, memoMap, scope);
          return yield* Effect.gen(function* () {
            const sessions = yield* Sessions.Sessions;
            const issued = yield* sessions.issue({ userId: Users.UserId("admin-1") });
            return `__Host-session=${encodeURIComponent(Redacted.value(issued.token))}`;
          }).pipe(Effect.provide(context));
        }),
      ),
    );
  return { handler, sessionCookie };
};

const call = (
  handler: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  options: { readonly cookie?: string; readonly body?: unknown } = {},
): Promise<Response> =>
  handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        cookie: [options.cookie, `${Api.CSRF_COOKIE_NAME}=${CSRF_VALUE}`]
          .filter(Boolean)
          .join("; "),
        "x-csrf-token": CSRF_VALUE,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );

const json = async (response: Response): Promise<Record<string, unknown>> => {
  const value: unknown = await response.json();
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
};

const newEndpoint = { url: "https://hooks.example.com/awthaq", eventTags: ["auth.user.*"] };

describe("webhooks admin over HTTP", () => {
  it.effect("an unauthenticated request is 401 before the gate is ever asked", () =>
    Effect.gen(function* () {
      const { handler } = build({ canManageWebhooks: () => Effect.succeed(true) });
      const response = yield* Effect.promise(() =>
        call(handler, "POST", "/admin/webhooks/endpoints", { body: newEndpoint }),
      );
      assert.strictEqual(response.status, 401);
    }),
  );

  it.effect("an authenticated caller is 403 while the gate is unconfigured (deny by default)", () =>
    Effect.gen(function* () {
      const { handler, sessionCookie } = build({});
      const cookie = yield* Effect.promise(sessionCookie);
      const response = yield* Effect.promise(() =>
        call(handler, "POST", "/admin/webhooks/endpoints", { cookie, body: newEndpoint }),
      );
      assert.strictEqual(response.status, 403);
      assert.strictEqual(
        (yield* Effect.promise(() => json(response)))["_tag"],
        "WebhooksActionDenied",
      );
    }),
  );

  it.effect(
    "create returns the secret once; list and get never do; the SSRF floor is a typed 422",
    () =>
      Effect.gen(function* () {
        const { handler, sessionCookie } = build({ canManageWebhooks: () => Effect.succeed(true) });
        const cookie = yield* Effect.promise(sessionCookie);

        const created = yield* Effect.promise(() =>
          call(handler, "POST", "/admin/webhooks/endpoints", { cookie, body: newEndpoint }),
        );
        assert.strictEqual(created.status, 200);
        const body = yield* Effect.promise(() => json(created));
        const secret = String(body["secret"]);
        assert.match(secret, /^whsec_/);
        const id = String((body["endpoint"] as { id: string }).id);

        const listed = yield* Effect.promise(() =>
          call(handler, "GET", "/admin/webhooks/endpoints", { cookie }),
        );
        const listedText = yield* Effect.promise(() => listed.text());
        assert.strictEqual(listed.status, 200);
        assert.include(listedText, id);
        assert.notInclude(listedText, secret);

        const rotated = yield* Effect.promise(() =>
          call(handler, "POST", `/admin/webhooks/endpoints/${id}/rotate-secret`, { cookie }),
        );
        assert.notStrictEqual(
          String((yield* Effect.promise(() => json(rotated)))["secret"]),
          secret,
        );

        const bad = yield* Effect.promise(() =>
          call(handler, "POST", "/admin/webhooks/endpoints", {
            cookie,
            body: { url: "https://169.254.169.254/latest", eventTags: ["*"] },
          }),
        );
        assert.strictEqual(bad.status, 422);
        assert.strictEqual(
          (yield* Effect.promise(() => json(bad)))["_tag"],
          "InvalidWebhookEndpoint",
        );

        const empty = yield* Effect.promise(() =>
          call(handler, "POST", "/admin/webhooks/endpoints", {
            cookie,
            body: { url: "https://hooks.example.com/x", eventTags: [] },
          }),
        );
        assert.strictEqual(empty.status, 400);

        const removed = yield* Effect.promise(() =>
          call(handler, "DELETE", `/admin/webhooks/endpoints/${id}`, { cookie }),
        );
        assert.strictEqual(removed.status, 204);
        const gone = yield* Effect.promise(() =>
          call(handler, "GET", `/admin/webhooks/endpoints/${id}`, { cookie }),
        );
        assert.strictEqual(gone.status, 404);
      }),
  );

  it.effect("a state-changing request without the CSRF token is refused before the gate", () =>
    Effect.gen(function* () {
      const { handler, sessionCookie } = build({ canManageWebhooks: () => Effect.succeed(true) });
      const cookie = yield* Effect.promise(sessionCookie);
      const response = yield* Effect.promise(() =>
        handler(
          new Request(`${ORIGIN}/admin/webhooks/endpoints`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify(newEndpoint),
          }),
        ),
      );
      assert.strictEqual(response.status, 403);
    }),
  );
});
