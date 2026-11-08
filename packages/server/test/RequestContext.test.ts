// ADR-EA-047 (plan 26), ALF-006: the one capture of a request's facts. Served through a one-group `HttpApi` whose
// group declares `Api.RequestContext`, with `RequestContextLive` as its implementation: every event the request raises
// carries the request's correlation id, address and (capped) user agent, on the bus and in the durable audit row.
import { Api } from "@awthaq/api";
import { AuditLog, AuthEvents, Observability, Persistence } from "@awthaq/core";
import { ClientAddress } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as RequestContext from "../src/RequestContext.ts";

const Facts = Schema.Struct({
  correlationId: Schema.String,
  ip: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  captured: Schema.Boolean,
});

const ProbeGroup = HttpApiGroup.make("probe")
  .add(HttpApiEndpoint.post("ping", "/ping", { success: Facts }))
  .middleware(Api.RequestContext);
const ProbeApi = HttpApi.make("auth").add(ProbeGroup);

/** Every log line a handler wrote, with its annotations. */
const logged: Array<Record<string, unknown>> = [];
const CaptureLogs = Logger.layer([
  Logger.make<unknown, void>((options) => {
    logged.push({ ...options.fiber.getRef(References.CurrentLogAnnotations) });
  }),
]);

// The handler publishes two events (as a handler with several audited effects would), logs once, and answers the
// facts it read, plus whether `capture` over the same request agrees with what the middleware provided.
const ProbeHandlers = HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
  Effect.gen(function* () {
    const events = yield* AuthEvents.AuthEvents;
    const deps = Layer.succeedContext(
      yield* Effect.context<ClientAddress.ClientAddress | SecureRandom.SecureRandom>(),
    );
    return handlers.handle("ping", ({ request }) =>
      Effect.gen(function* () {
        yield* events.publish({ _tag: "auth.token.replay", identifier: "first" });
        yield* events.publish({ _tag: "auth.token.replay", identifier: "second" });
        yield* Effect.logInfo("ping");
        const context = yield* Api.AuthRequestContext;
        if (!Api.isRequest(context)) return yield* Effect.die("no request");
        const captured = yield* RequestContext.capture(request).pipe(Effect.provide(deps));
        return {
          correlationId: context.correlationId,
          ip: Option.getOrNull(context.ip),
          userAgent: Option.getOrNull(context.userAgent),
          captured:
            Api.isRequest(captured) &&
            Option.getOrNull(captured.ip) === Option.getOrNull(context.ip) &&
            Option.getOrNull(captured.userAgent) === Option.getOrNull(context.userAgent),
        };
      }),
    );
  }),
);

const Services = AuthEvents.layer.pipe(
  Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
  Layer.provideMerge(NodeCrypto.layer),
);

/** The app over `address`, served as a web handler, with its own audit log. */
const serve = (address: Layer.Layer<ClientAddress.ClientAddress>) => {
  const app = HttpApiBuilder.layer(ProbeApi).pipe(
    Layer.provide(ProbeHandlers),
    Layer.provide(RequestContext.RequestContextLive),
    Layer.provideMerge(address),
    Layer.provideMerge(Services),
    Layer.provideMerge(CaptureLogs),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
  );
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler, dispose } = HttpRouter.toWebHandler(app, { memoMap, disableLogger: true });
  const ping = (headers: Record<string, string> = {}) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request("http://localhost/ping", { method: "POST", headers }),
      );
      assert.strictEqual(response.status, 200);
      return Schema.decodeUnknownSync(Facts)(await response.json());
    });
  const auditRows = Effect.promise(() =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.buildWithMemoMap(app, memoMap, yield* Effect.scope);
          return yield* Effect.flatMap(Effect.service(AuditLog.AuditLog), (log) => log.list()).pipe(
            Effect.provide(context),
          );
        }),
      ),
    ),
  );
  return { ping, auditRows, dispose: Effect.promise(dispose) };
};

const forwarded = ClientAddress.layerTrustedProxy({ strategy: { _tag: "hopCount", count: 1 } });

describe("RequestContext (ADR-EA-047, ALF-006)", () => {
  it.effect(
    "x-request-id is the correlation id of every event the request raised; the address is what ClientAddress resolves",
    () =>
      Effect.gen(function* () {
        const app = serve(forwarded);
        const facts = yield* app.ping({
          "x-request-id": "r-1",
          "user-agent": "vitest/1",
          "x-forwarded-for": "203.0.113.7, 10.0.0.1",
        });
        assert.deepStrictEqual(facts, {
          correlationId: "r-1",
          ip: "203.0.113.7",
          userAgent: "vitest/1",
          captured: true,
        });
        const rows = yield* app.auditRows;
        assert.strictEqual(rows.length, 2);
        for (const row of rows) {
          assert.deepStrictEqual(row.correlationId, Option.some("r-1"));
          assert.deepStrictEqual(row.ip, Option.some("203.0.113.7"));
          assert.deepStrictEqual(row.userAgent, Option.some("vitest/1"));
        }
        yield* app.dispose;
      }),
  );

  it.effect(
    "a web handler under layerDirect reports no address; the user agent is capped at 512",
    () =>
      Effect.gen(function* () {
        const app = serve(ClientAddress.layerDirect);
        const facts = yield* app.ping({ "user-agent": "u".repeat(600) });
        assert.strictEqual(facts.ip, null);
        assert.strictEqual(facts.userAgent?.length, Api.MAX_USER_AGENT_LENGTH);
        yield* app.dispose;
      }),
  );

  it.effect("the handler's log lines carry the correlation id", () =>
    Effect.gen(function* () {
      logged.length = 0;
      const app = serve(ClientAddress.layerDirect);
      yield* app.ping({ "x-request-id": "logged-1" });
      assert.isTrue(
        logged.some((annotations) => annotations[Observability.Field.correlationId] === "logged-1"),
      );
      yield* app.dispose;
    }),
  );

  it.effect(
    "every event one request raised shares one correlation id, even with no caller id",
    () =>
      Effect.gen(function* () {
        const app = serve(ClientAddress.layerDirect);
        const facts = yield* app.ping();
        const rows = yield* app.auditRows;
        const ids = rows.map((row) => Option.getOrElse(row.correlationId, () => ""));
        assert.deepStrictEqual(ids, [facts.correlationId, facts.correlationId]);
        assert.notStrictEqual(facts.correlationId, "");
        yield* app.dispose;
      }),
  );

  it.effect("two concurrent requests each see their own facts and stamp their own events", () =>
    Effect.gen(function* () {
      const app = serve(forwarded);
      const [first, second] = yield* Effect.all(
        [
          app.ping({ "x-request-id": "c-1", "x-forwarded-for": "198.51.100.1, 10.0.0.1" }),
          app.ping({ "x-request-id": "c-2", "x-forwarded-for": "198.51.100.2, 10.0.0.1" }),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual([first.ip, second.ip], ["198.51.100.1", "198.51.100.2"]);
      const rows = yield* app.auditRows;
      const pairs = rows.map((row) => [
        Option.getOrNull(row.correlationId),
        Option.getOrNull(row.ip),
      ]);
      assert.sameDeepMembers(pairs, [
        ["c-1", "198.51.100.1"],
        ["c-1", "198.51.100.1"],
        ["c-2", "198.51.100.2"],
        ["c-2", "198.51.100.2"],
      ]);
      yield* app.dispose;
    }),
  );

  it.effect("capture reads the same facts outside a declared group", () =>
    Effect.gen(function* () {
      const request = HttpServerRequest.fromWeb(
        new Request("http://localhost/host-route", {
          headers: { "x-request-id": "host-1", "user-agent": "host/1" },
        }),
      );
      const facts = yield* RequestContext.capture(request).pipe(
        Effect.provide(Layer.merge(ClientAddress.layerDirect, NodeCrypto.layer)),
      );
      assert.deepStrictEqual(
        facts,
        Api.AuthRequestContext.request({ correlationId: "host-1", userAgent: "host/1" }),
      );
    }),
  );

  // The precedence of the correlation-id sources, pinned as a pure function.
  it("falls back to a traceparent's trace id, and ignores an all-zero one", () => {
    const headers =
      (values: Readonly<Record<string, string>>) =>
      (name: string): string | undefined =>
        values[name];
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    assert.deepStrictEqual(
      RequestContext.correlationIdFrom(headers({ traceparent })),
      Option.some("0af7651916cd43dd8448eb211c80319c"),
    );
    assert.deepStrictEqual(
      RequestContext.correlationIdFrom(headers({ traceparent, "x-request-id": "r-9" })),
      Option.some("r-9"),
    );
    assert.deepStrictEqual(
      RequestContext.correlationIdFrom(
        headers({ traceparent: `00-${"0".repeat(32)}-b7ad6b7169203331-01` }),
      ),
      Option.none(),
    );
  });

  it("an unusable x-request-id is ignored, never stored", () => {
    const header = (value: string) => (name: string) =>
      name === "x-request-id" ? value : undefined;
    assert.deepStrictEqual(RequestContext.correlationIdFrom(header("has spaces")), Option.none());
    assert.deepStrictEqual(
      RequestContext.correlationIdFrom(header("x".repeat(129))),
      Option.none(),
    );
    assert.deepStrictEqual(
      RequestContext.correlationIdFrom(header("ok-1.2:3")),
      Option.some("ok-1.2:3"),
    );
  });
});
