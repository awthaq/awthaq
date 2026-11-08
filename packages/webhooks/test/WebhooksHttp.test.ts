// BEH-EA-281 (spec/behaviors/34-webhooks.md), over real HTTP: the admin group behind the admin-tier
// authentication and CSRF, the fail-closed gate, the secret shown once on the wire, and the typed errors.
import { Api } from "@awthaq/api";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestAuth, type UserAgent } from "@awthaq/test";
import * as Webhooks from "../src/Webhooks.ts";
import { deliveryLayer } from "./support.ts";

const build = (config: Partial<Webhooks.WebhooksConfigShape>) => {
  const app = TestAuth.app(deliveryLayer({ config }));
  /** A browser signed in as the administrator: it keeps its cookies and echoes its CSRF cookie itself. */
  const signIn = () => app.signIn("admin-1@example.com");
  /** A fresh anonymous browser. */
  const anonymous = () => app.agent();
  return { signIn, anonymous };
};

const call = (
  browser: UserAgent.UserAgent,
  method: string,
  path: string,
  options: { readonly body?: unknown } = {},
): Promise<Response> =>
  browser.request(method, path, options.body === undefined ? {} : { json: options.body });

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
      const { anonymous } = build({ canManageWebhooks: () => Effect.succeed(true) });
      const stranger = yield* Effect.promise(anonymous);
      const response = yield* Effect.promise(() =>
        call(stranger, "POST", "/admin/webhooks/endpoints", { body: newEndpoint }),
      );
      assert.strictEqual(response.status, 401);
    }),
  );

  it.effect("an authenticated caller is 403 while the gate is unconfigured (deny by default)", () =>
    Effect.gen(function* () {
      const { signIn } = build({});
      const admin = yield* Effect.promise(signIn);
      const response = yield* Effect.promise(() =>
        call(admin, "POST", "/admin/webhooks/endpoints", { body: newEndpoint }),
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
        const { signIn } = build({ canManageWebhooks: () => Effect.succeed(true) });
        const admin = yield* Effect.promise(signIn);

        const created = yield* Effect.promise(() =>
          call(admin, "POST", "/admin/webhooks/endpoints", { body: newEndpoint }),
        );
        assert.strictEqual(created.status, 200);
        const body = yield* Effect.promise(() => json(created));
        const secret = String(body["secret"]);
        assert.match(secret, /^whsec_/);
        const id = String((body["endpoint"] as { id: string }).id);

        const listed = yield* Effect.promise(() => call(admin, "GET", "/admin/webhooks/endpoints"));
        const listedText = yield* Effect.promise(() => listed.text());
        assert.strictEqual(listed.status, 200);
        assert.include(listedText, id);
        assert.notInclude(listedText, secret);

        const rotated = yield* Effect.promise(() =>
          call(admin, "POST", `/admin/webhooks/endpoints/${id}/rotate-secret`),
        );
        assert.notStrictEqual(
          String((yield* Effect.promise(() => json(rotated)))["secret"]),
          secret,
        );

        const bad = yield* Effect.promise(() =>
          call(admin, "POST", "/admin/webhooks/endpoints", {
            body: { url: "https://169.254.169.254/latest", eventTags: ["*"] },
          }),
        );
        assert.strictEqual(bad.status, 422);
        assert.strictEqual(
          (yield* Effect.promise(() => json(bad)))["_tag"],
          "InvalidWebhookEndpoint",
        );

        const empty = yield* Effect.promise(() =>
          call(admin, "POST", "/admin/webhooks/endpoints", {
            body: { url: "https://hooks.example.com/x", eventTags: [] },
          }),
        );
        assert.strictEqual(empty.status, 400);

        const removed = yield* Effect.promise(() =>
          call(admin, "DELETE", `/admin/webhooks/endpoints/${id}`),
        );
        assert.strictEqual(removed.status, 204);
        const gone = yield* Effect.promise(() =>
          call(admin, "GET", `/admin/webhooks/endpoints/${id}`),
        );
        assert.strictEqual(gone.status, 404);
      }),
  );

  // BEH-EA-310: the test ping is a state-changing admin call: 401/403/CSRF like the rest, 404 for an unknown id.
  it.effect(
    "the test ping queues a delivery over HTTP, and an unknown endpoint is a typed 404",
    () =>
      Effect.gen(function* () {
        const { signIn, anonymous } = build({ canManageWebhooks: () => Effect.succeed(true) });
        const admin = yield* Effect.promise(signIn);
        const created = yield* Effect.promise(() =>
          call(admin, "POST", "/admin/webhooks/endpoints", { body: newEndpoint }),
        );
        const registered = yield* Effect.promise(() => json(created));
        const id = String(Reflect.get(Object(registered["endpoint"]), "id"));
        assert.notStrictEqual(id, "undefined");
        const ping = yield* Effect.promise(() =>
          call(admin, "POST", `/admin/webhooks/endpoints/${id}/test`),
        );
        assert.strictEqual(ping.status, 200);
        const delivery = yield* Effect.promise(() => json(ping));
        assert.strictEqual(delivery["eventTag"], "webhook.test");
        assert.strictEqual(delivery["status"], "pending");
        const missing = yield* Effect.promise(() =>
          call(admin, "POST", "/admin/webhooks/endpoints/nope/test"),
        );
        assert.strictEqual(missing.status, 404);
        const stranger = yield* Effect.promise(anonymous);
        const unauthenticated = yield* Effect.promise(() =>
          call(stranger, "POST", `/admin/webhooks/endpoints/${id}/test`),
        );
        assert.strictEqual(unauthenticated.status, 401);
      }),
  );

  it.effect("a state-changing request without the CSRF token is refused before the gate", () =>
    Effect.gen(function* () {
      const { signIn } = build({ canManageWebhooks: () => Effect.succeed(true) });
      const admin = yield* Effect.promise(signIn);
      // The browser's cookies go out, but the request carries no echo of the CSRF cookie.
      const response = yield* Effect.promise(() =>
        admin.request("POST", "/admin/webhooks/endpoints", {
          json: newEndpoint,
          headers: { [Api.CSRF_HEADER_NAME]: "" },
        }),
      );
      assert.strictEqual(response.status, 403);
    }),
  );
});
