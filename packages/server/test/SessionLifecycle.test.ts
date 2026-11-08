// ADR-EA-045, BEH-EA-343: the server half of the `SessionLifecycle` markers and the `SessionDelivery` functions
// over the grants they provide. One `HttpApi`, served through `HttpRouter.toWebHandler` (pre-response handlers
// only run inside the request state `HttpEffect.toHandled` installs), with `AuthHttp.sessionLifecycle` wired by
// hand. Each endpoint's handler is chosen by the test through a `Ref`, so one server covers every case.
import { Api, SessionContract, SessionLifecycle } from "@awthaq/api";
import { Sessions, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as AuthHttp from "../src/AuthHttp.ts";
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
const ROTATED = "rotated-at-verify";
const issued: Sessions.IssuedSession = { session, token: Redacted.make(TOKEN) };

class Refused extends Schema.TaggedError<Refused>()("Refused", {}, { httpApiStatus: 401 }) {}

type Behaviour =
  | "respond"
  | "decline"
  | "nothing"
  | "refuse"
  | "deliverBearer"
  | "deliverExchanged"
  | "redirect";

/** A verify-time rotation registers its `set-auth-token` before the handler; this stands in for it. */
const rotatedAtVerify = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, Api.ROTATED_TOKEN_HEADER, ROTATED)),
);

const LifecycleApi = HttpApi.make("auth").add(
  HttpApiGroup.make("g")
    .add(
      HttpApiEndpoint.post("mint", "/mint", {
        payload: Schema.Struct({ behaviour: Schema.String }),
        success: [SessionContract.SessionDto, Schema.String],
        error: Refused,
      }).middleware(SessionLifecycle.Mints),
    )
    .add(
      HttpApiEndpoint.post("rotate", "/rotate", { success: SessionContract.SessionDto }).middleware(
        SessionLifecycle.Rotates,
      ),
    )
    .add(
      HttpApiEndpoint.post("callback", "/callback", { success: Schema.String }).middleware(
        SessionLifecycle.Mints,
      ),
    )
    .add(HttpApiEndpoint.post("end", "/end").middleware(SessionLifecycle.Ends))
    .add(HttpApiEndpoint.post("swapIn", "/swap-in").middleware(SessionLifecycle.Swaps))
    .add(HttpApiEndpoint.post("swapOut", "/swap-out").middleware(SessionLifecycle.Swaps))
    .add(HttpApiEndpoint.post("refresh", "/refresh").middleware(SessionLifecycle.Refreshes)),
);

let handlerRuns = 0;

const Handlers = HttpApiBuilder.group(LifecycleApi, "g", (handlers) =>
  handlers
    .handle("mint", ({ payload }) =>
      Effect.gen(function* () {
        handlerRuns++;
        const behaviour: string = payload.behaviour;
        switch (behaviour) {
          case "respond":
            return yield* SessionDelivery.respond(Effect.succeed(issued));
          case "decline":
            yield* SessionDelivery.decline(SessionLifecycle.MintGrant);
            return "declined";
          case "refuse":
            return yield* Effect.fail(new Refused());
          case "deliverBearer":
            return yield* SessionDelivery.deliverBearer(issued);
          case "deliverExchanged":
            return yield* SessionDelivery.deliverExchanged(
              new SessionContract.SessionDto({
                id: "s",
                createdAt: session.createdAt,
                lastActiveAt: session.lastActiveAt,
                expiresAt: session.absoluteExpiresAt,
                userAgent: null,
                amr: ["pwd"],
                current: true,
                token: "from-the-exchange",
              }),
            );
          default:
            return "nothing";
        }
      }),
    )
    .handle("rotate", () =>
      Effect.gen(function* () {
        yield* rotatedAtVerify;
        return yield* SessionDelivery.respond(Effect.succeed(issued));
      }),
    )
    .handleRaw("callback", () =>
      SessionDelivery.redirect(HttpServerResponse.redirect("http://localhost/landed"), issued),
    )
    .handle("end", () =>
      Effect.gen(function* () {
        yield* rotatedAtVerify;
        yield* SessionDelivery.end;
      }),
    )
    .handle("swapIn", () => SessionDelivery.swapIn(issued))
    .handle("swapOut", () => SessionDelivery.swapOut)
    .handle("refresh", () => Effect.void),
);

const { handler } = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(LifecycleApi).pipe(
    Layer.provide(Handlers),
    Layer.provide(AuthHttp.sessionLifecycle),
    Layer.provide(HttpServer.layerServices),
  ),
  { disableLogger: true },
);

const post = (path: string, headers: Record<string, string> = {}, json?: unknown) =>
  Effect.promise(() =>
    handler(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      }),
    ),
  );

const mint = (behaviour: Behaviour, headers: Record<string, string> = {}) =>
  post("/mint", headers, { behaviour });

const bodyOf = (response: Response) =>
  Effect.promise((): Promise<unknown> => response.json().catch(() => null));

const bearer = { [Api.TOKEN_DELIVERY_HEADER]: "bearer" };

/** The one `Set-Cookie` line naming `name` (not whichever cookie the joined header happens to list first). */
const setCookieNamed = (response: Response, name: string): string =>
  response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`)) ?? "";

describe("SessionLifecycle markers (ADR-EA-045)", () => {
  it.effect(
    "Mints: an unknown X-Awthaq-Token-Delivery answers 400 and the handler never runs",
    () =>
      Effect.gen(function* () {
        const before = handlerRuns;
        const response = yield* mint("respond", { [Api.TOKEN_DELIVERY_HEADER]: "carrier-pigeon" });
        assert.strictEqual(response.status, 400);
        assert.deepStrictEqual(yield* bodyOf(response), { _tag: "InvalidTokenDelivery" });
        assert.strictEqual(handlerRuns, before, "the handler never started");
        assert.isNull(response.headers.get("set-cookie"));
      }),
  );

  it.effect(
    "Mints: a success that neither delivered nor declined dies SessionLifecycleUnsettled",
    () =>
      Effect.gen(function* () {
        const response = yield* mint("nothing");
        assert.strictEqual(response.status, 500);
      }),
  );

  it.effect("Mints: a typed handler failure without settling is not a defect", () =>
    Effect.gen(function* () {
      const response = yield* mint("refuse");
      assert.strictEqual(response.status, 401);
      assert.deepStrictEqual(yield* bodyOf(response), { _tag: "Refused" });
      assert.strictEqual(response.headers.get("cache-control"), "no-store");
    }),
  );

  it.effect("Mints: decline settles; the response is no-store and carries no cookie", () =>
    Effect.gen(function* () {
      const response = yield* mint("decline");
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("cache-control"), "no-store");
      assert.isNull(response.headers.get("set-cookie"));
    }),
  );

  it.effect("Refreshes: passes the handler through unchanged", () =>
    Effect.gen(function* () {
      const response = yield* post("/refresh", bearer);
      assert.strictEqual(response.status, 204);
      assert.isNull(response.headers.get("cache-control"));
    }),
  );
});

describe("SessionDelivery over the grants (ADR-EA-045, MNA-001)", () => {
  it.effect(
    "respond in cookie mode sets the session cookie, omits the token and sends no set-auth-token",
    () =>
      Effect.gen(function* () {
        const response = yield* mint("respond");
        assert.strictEqual(response.status, 200);
        assert.include(
          setCookieNamed(response, Sessions.SESSION_COOKIE_NAME),
          `${Sessions.SESSION_COOKIE_NAME}=${TOKEN}`,
        );
        assert.isNull(response.headers.get(Api.ROTATED_TOKEN_HEADER));
        assert.notInclude(JSON.stringify(yield* bodyOf(response)), TOKEN);
        assert.strictEqual(response.headers.get("cache-control"), "no-store");
      }),
  );

  it.effect(
    "respond in bearer mode sets no cookie and carries the token in the body and in set-auth-token",
    () =>
      Effect.gen(function* () {
        const response = yield* mint("respond", bearer);
        assert.strictEqual(response.status, 200);
        assert.isNull(response.headers.get("set-cookie"));
        assert.strictEqual(response.headers.get(Api.ROTATED_TOKEN_HEADER), TOKEN);
        assert.deepInclude(yield* bodyOf(response), { token: TOKEN });
        assert.strictEqual(response.headers.get("cache-control"), "no-store");
      }),
  );

  it.effect(
    "respond after a verify-time rotation: set-auth-token is the minted token (the later handler wins)",
    () =>
      Effect.gen(function* () {
        const response = yield* post("/rotate", bearer);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get(Api.ROTATED_TOKEN_HEADER), TOKEN);
      }),
  );

  it.effect(
    "end expires the session cookie, sets x-awthaq-session-ended and drops a rotation's set-auth-token",
    () =>
      Effect.gen(function* () {
        const response = yield* post("/end", bearer);
        assert.strictEqual(response.status, 204);
        assert.match(
          setCookieNamed(response, Sessions.SESSION_COOKIE_NAME),
          new RegExp(`^${Sessions.SESSION_COOKIE_NAME}=;`),
        );
        assert.strictEqual(response.headers.get(Api.SESSION_ENDED_HEADER), "1");
        assert.isNull(response.headers.get(Api.ROTATED_TOKEN_HEADER));
        assert.strictEqual(response.headers.get("cache-control"), "no-store");
      }),
  );

  it.effect(
    "Swaps: bearer answers 400 before the handler; swapIn sets the impersonation cookie; swapOut expires it",
    () =>
      Effect.gen(function* () {
        const refused = yield* post("/swap-in", bearer);
        assert.strictEqual(refused.status, 400);
        assert.isNull(refused.headers.get("set-cookie"));
        const swapped = yield* post("/swap-in");
        assert.strictEqual(swapped.status, 204);
        assert.include(
          setCookieNamed(swapped, Api.IMPERSONATION_COOKIE_NAME),
          `${Api.IMPERSONATION_COOKIE_NAME}=${TOKEN}`,
        );
        const back = yield* post("/swap-out");
        assert.strictEqual(back.status, 204);
        assert.match(
          setCookieNamed(back, Api.IMPERSONATION_COOKIE_NAME),
          new RegExp(`^${Api.IMPERSONATION_COOKIE_NAME}=;`),
        );
      }),
  );

  it.effect(
    "deliverBearer ignores a cookie-mode request; deliverExchanged names the DTO's token in set-auth-token",
    () =>
      Effect.gen(function* () {
        const device = yield* mint("deliverBearer");
        assert.isNull(device.headers.get("set-cookie"));
        assert.strictEqual(device.headers.get(Api.ROTATED_TOKEN_HEADER), TOKEN);
        assert.deepInclude(yield* bodyOf(device), { token: TOKEN });
        const exchanged = yield* mint("deliverExchanged");
        assert.strictEqual(exchanged.headers.get(Api.ROTATED_TOKEN_HEADER), "from-the-exchange");
        assert.strictEqual(exchanged.headers.get("cache-control"), "no-store");
      }),
  );

  it.effect("redirect puts the session cookie on the navigation response", () =>
    Effect.gen(function* () {
      const response = yield* post("/callback");
      assert.strictEqual(response.status, 302);
      assert.strictEqual(response.headers.get("location"), "http://localhost/landed");
      assert.include(
        setCookieNamed(response, Sessions.SESSION_COOKIE_NAME),
        `${Sessions.SESSION_COOKIE_NAME}=${TOKEN}`,
      );
    }),
  );
});
