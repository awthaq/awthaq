// MNA-001 / WPS-004: `SessionDelivery.respond(request, mint)` is mode -> mint -> deliver in one call. Served through a
// real router so the cookie and `Cache-Control` writes land on the response the way a plugin handler's do.
import { Api } from "@awthaq/api";
import { Sessions, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as SessionDelivery from "../src/SessionDelivery.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const session: Sessions.SessionView = {
  id: Sessions.SessionId("session-1"),
  userId: Users.UserId("user-1"),
  createdAt: at("2024-01-01T00:00:00.000Z"),
  authenticatedAt: at("2024-01-01T00:00:00.000Z"),
  lastActiveAt: at("2024-01-01T00:00:00.000Z"),
  absoluteExpiresAt: at("2099-02-01T00:00:00.000Z"),
  idleExpiresAt: at("2099-01-09T00:00:00.000Z"),
  ipAddress: Option.none(),
  userAgent: Option.none(),
  actingAs: Option.none(),
  amr: ["pwd"],
  tenantId: Option.none(),
};

const TOKEN = "raw-session-token";

/** A route that mints through `respond`, counting how many times `mint` ran. */
const serve = (minted: Ref.Ref<number>) => {
  const route = HttpRouter.add(
    "POST",
    "/mint",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const dto = yield* SessionDelivery.respond(
        request,
        Ref.update(minted, (count) => count + 1).pipe(
          Effect.as({ session, token: Redacted.make(TOKEN) }),
        ),
      ).pipe(Effect.catchTag("InvalidTokenDelivery", () => Effect.succeed(undefined)));
      return dto === undefined
        ? HttpServerResponse.empty({ status: 400 })
        : yield* HttpServerResponse.json(dto);
    }),
  );
  return HttpRouter.toWebHandler(route.pipe(Layer.provide(HttpRouter.layer)), {
    disableLogger: true,
  });
};

const send = (headers: Record<string, string>) =>
  Effect.gen(function* () {
    const minted = yield* Ref.make(0);
    const { handler, dispose } = serve(minted);
    const response = yield* Effect.promise(() =>
      handler(new Request("http://localhost/mint", { method: "POST", headers })),
    ).pipe(Effect.ensuring(Effect.promise(dispose)));
    const body: unknown = yield* Effect.promise(() =>
      response
        .clone()
        .json()
        .catch(() => null),
    );
    return { response, body, minted: yield* Ref.get(minted) };
  });

describe("SessionDelivery.respond (MNA-001)", () => {
  it.effect(
    "an invalid X-Awthaq-Token-Delivery fails InvalidTokenDelivery and mint never runs",
    () =>
      Effect.gen(function* () {
        const { response, minted } = yield* send({ [Api.TOKEN_DELIVERY_HEADER]: "carrier-pigeon" });
        assert.strictEqual(response.status, 400);
        assert.strictEqual(minted, 0, "nothing was minted for a refused request");
        assert.isNull(response.headers.get("set-cookie"));
      }),
  );

  it.effect(
    "cookie mode (the default) sets the session cookie and omits the token from the body",
    () =>
      Effect.gen(function* () {
        const { response, body, minted } = yield* send({});
        assert.strictEqual(response.status, 200);
        assert.strictEqual(minted, 1);
        assert.include(response.headers.get("set-cookie") ?? "", TOKEN);
        assert.notInclude(JSON.stringify(body), TOKEN);
        assert.isNull(response.headers.get("cache-control"));
      }),
  );

  it.effect(
    "bearer mode sets Cache-Control: no-store and returns the token in the body, with no cookie",
    () =>
      Effect.gen(function* () {
        const { response, body, minted } = yield* send({ [Api.TOKEN_DELIVERY_HEADER]: "bearer" });
        assert.strictEqual(response.status, 200);
        assert.strictEqual(minted, 1);
        assert.strictEqual(response.headers.get("cache-control"), "no-store");
        assert.isNull(response.headers.get("set-cookie"));
        assert.deepInclude(body, { token: TOKEN });
      }),
  );
});
