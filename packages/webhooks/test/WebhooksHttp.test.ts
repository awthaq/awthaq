// BEH-EA-281 (spec/behaviors/34-webhooks.md), over real HTTP: the admin group behind the admin-tier
// authentication and CSRF, the fail-closed gate, the secret shown once on the wire, and the typed errors.
import { Api } from "@awthaq/api";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestAuth } from "@awthaq/test";
import * as Webhooks from "../src/Webhooks.ts";
import { deliveryLayer } from "./support.ts";

// `<iat>.<random>.<hmac(iat.random)>`, computed independently of `Csrf.ts` with `node:crypto`, over the secret the
// composition's own derived `CsrfProtection` checks.
const CSRF_VALUE: string = TestAuth.csrfToken(TestAuth.TestCsrfConfig.secret);

const ORIGIN = "http://localhost:3000";

const build = (config: Partial<Webhooks.WebhooksConfigShape>) => {
  const app = TestAuth.app(deliveryLayer({ config }));
  const sessionCookie = (): Promise<string> =>
    app.signIn("admin-1@example.com").then((signedIn) => signedIn.cookieHeader);
  return { handler: app.handler, sessionCookie };
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

  // BEH-EA-310: the test ping is a state-changing admin call: 401/403/CSRF like the rest, 404 for an unknown id.
  it.effect(
    "the test ping queues a delivery over HTTP, and an unknown endpoint is a typed 404",
    () =>
      Effect.gen(function* () {
        const { handler, sessionCookie } = build({ canManageWebhooks: () => Effect.succeed(true) });
        const cookie = yield* Effect.promise(sessionCookie);
        const created = yield* Effect.promise(() =>
          call(handler, "POST", "/admin/webhooks/endpoints", { cookie, body: newEndpoint }),
        );
        const registered = yield* Effect.promise(() => json(created));
        const id = String(Reflect.get(Object(registered["endpoint"]), "id"));
        assert.notStrictEqual(id, "undefined");
        const ping = yield* Effect.promise(() =>
          call(handler, "POST", `/admin/webhooks/endpoints/${id}/test`, { cookie }),
        );
        assert.strictEqual(ping.status, 200);
        const delivery = yield* Effect.promise(() => json(ping));
        assert.strictEqual(delivery["eventTag"], "webhook.test");
        assert.strictEqual(delivery["status"], "pending");
        const missing = yield* Effect.promise(() =>
          call(handler, "POST", "/admin/webhooks/endpoints/nope/test", { cookie }),
        );
        assert.strictEqual(missing.status, 404);
        const anonymous = yield* Effect.promise(() =>
          call(handler, "POST", `/admin/webhooks/endpoints/${id}/test`),
        );
        assert.strictEqual(anonymous.status, 401);
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
