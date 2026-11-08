// BEH-EA-333/BEH-EA-344 (architecture plan 20): the in-process user agent, as `TestAuth.app` hands it out and as
// the server-action client is built on it.
import { SessionCookie } from "@awthaq/core";
import { TestAuth } from "@awthaq/test";
import { inProcessClient } from "@awthaq/web";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { World as NextWorld } from "./NextSsrWorld.ts";
import { World as HarnessWorld } from "./TestingHarnessWorld.ts";
import { isBoolean, isNumber, isString } from "./shared/Outcomes.ts";
import { ledgerBuilt } from "./TestingHarnessComposeFixtures.ts";

// ---- BEH-EA-333: TestAuth.app hands out agents ------------------------------------------------

export const userAgentHarnessSteps = defineSteps<HarnessWorld>(({ Given, When, Then }) => {
  When(
    "one agent of the app is signed in and a second agent of the same app is fresh",
    function* () {
      const { outcomes } = yield* HarnessWorld;
      const app = TestAuth.app(TestAuth.layer(ledgerBuilt));
      const statuses = yield* Effect.promise(async () => {
        try {
          const alice = await app.signIn("alice@example.com");
          const bob = await app.agent();
          return {
            alice: (await alice.request("GET", "/session")).status,
            bob: (await bob.request("GET", "/session")).status,
          };
        } finally {
          await app.dispose();
        }
      });
      yield* outcomes.set("signedInStatus", statuses.alice);
      yield* outcomes.set("freshStatus", statuses.bob);
    },
  );

  Then("the signed-in agent's session is served and the fresh agent's is refused", function* () {
    const { outcomes } = yield* HarnessWorld;
    assert.equal(yield* outcomes.getAs("signedInStatus", isNumber), 200);
    assert.equal(yield* outcomes.getAs("freshStatus", isNumber), 401);
  });

  Given(
    "a composition served through {string} under the {string} cookie mode for {string}",
    function* (_entry: string, _mode: string, domain: string) {
      const { outcomes } = yield* HarnessWorld;
      yield* outcomes.set("cookieDomain", domain);
    },
  );

  When("an agent is signed in through the app at {string}", function* (baseUrl: string) {
    const { outcomes } = yield* HarnessWorld;
    const domain = yield* outcomes.getAs("cookieDomain", isString);
    const app = TestAuth.app(
      TestAuth.layer(ledgerBuilt, {
        services: SessionCookie.config({
          mode: SessionCookie.SecureDomain({ domain, sameSite: "lax" }),
        }),
      }),
      { baseUrl },
    );
    const seen = yield* Effect.promise(async () => {
      try {
        const alice = await app.signIn("alice@example.com");
        const held = alice.cookies.get("__Secure-session");
        return {
          domain: held?.domain ?? "",
          status: (await alice.request("GET", "/session")).status,
        };
      } finally {
        await app.dispose();
      }
    });
    yield* outcomes.set("heldDomain", seen.domain);
    yield* outcomes.set("sessionStatus", seen.status);
  });

  Then(
    "it holds {string} for {string} and its session request is served",
    function* (name: string, domain: string) {
      const { outcomes } = yield* HarnessWorld;
      assert.equal(name, "__Secure-session");
      assert.equal(yield* outcomes.getAs("heldDomain", isString), domain);
      assert.equal(yield* outcomes.getAs("sessionStatus", isNumber), 200);
    },
  );
});

// ---- BEH-EA-344: the server-action client honours Expires within the action ------------------

const Ok = Schema.Struct({ ok: Schema.Boolean });

const ActionApi = HttpApi.make("user-agent-action").add(
  HttpApiGroup.make("app")
    .add(HttpApiEndpoint.post("set", "/app/set", { success: Ok }))
    .add(HttpApiEndpoint.post("expire", "/app/expire", { success: Ok }))
    .add(
      HttpApiEndpoint.post("echo", "/app/echo", {
        success: Schema.Struct({ cookie: Schema.NullOr(Schema.String) }),
      }),
    ),
);

const ActionHandlers = HttpApiBuilder.group(ActionApi, "app", (handlers) =>
  handlers
    .handle("set", () => Effect.succeed({ ok: true }))
    .handle("expire", () => Effect.succeed({ ok: true }))
    .handle(
      "echo",
      Effect.fnUntraced(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return { cookie: request.headers["cookie"] ?? null };
      }),
    ),
);

const ActionLayer = HttpApiBuilder.layer(ActionApi).pipe(
  Layer.provide(ActionHandlers),
  Layer.provideMerge(
    Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
      Layer.provideMerge(FileSystem.layerNoop({})),
    ),
  ),
  Layer.provideMerge(HttpRouter.layer),
);

/** The application's own route writes the cookie: `/app/set` sets it, `/app/expire` expires it by `Expires` alone. */
const withApplicationCookie =
  (handler: (request: Request) => Promise<Response>) => async (request: Request) => {
    const response = await handler(request);
    const headers = new Headers(response.headers);
    const path = new URL(request.url).pathname;
    if (path === "/app/set") headers.append("set-cookie", "theme=dark; Path=/");
    if (path === "/app/expire") {
      headers.append("set-cookie", "theme=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    }
    return new Response(response.body, { status: response.status, headers });
  };

export const userAgentNextSteps = defineSteps<NextWorld>(({ Given, When, Then }) => {
  Given(
    "a server action's in-process client over an application route that sets a cookie and one that expires it by {string}",
    function* (_attribute: string) {
      yield* Effect.void;
    },
  );

  When("the action sets the cookie, expires it, and then makes a third call", function* () {
    const { outcomes } = yield* NextWorld;
    const { handler, dispose } = HttpRouter.toWebHandler(ActionLayer);
    const seen = yield* Effect.promise(async () => {
      try {
        const jar: Array<string> = [];
        const client = await inProcessClient(ActionApi, {
          handler: withApplicationCookie(handler),
          headers: { get: () => null },
          jar: { set: (name) => jar.push(name) },
        });
        await client.app.set();
        const between = (await client.app.echo()).cookie ?? "";
        await client.app.expire();
        const after = (await client.app.echo()).cookie ?? "";
        return { between, after };
      } finally {
        await dispose();
      }
    });
    yield* outcomes.set("sentBetween", seen.between.includes("theme=dark"));
    yield* outcomes.set("sentAfter", seen.after.includes("theme="));
  });

  Then("the third call carries no such cookie", function* () {
    const { outcomes } = yield* NextWorld;
    assert.equal(yield* outcomes.getAs("sentBetween", isBoolean), true);
    assert.equal(yield* outcomes.getAs("sentAfter", isBoolean), false);
  });
});
