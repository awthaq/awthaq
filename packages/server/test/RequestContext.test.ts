// ALF-006: every event one HTTP request raises carries the request's correlation
// id (and client address / user agent) — on the bus and in the durable audit row.
// Exercised against a real Node HTTP server through the global middleware.
import { AuditLog, AuthEvents } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as RequestContext from "../src/RequestContext.ts";

/** A route that publishes two events, as a handler with several audited effects would. */
const pingRoute = HttpRouter.add(
  "POST",
  "/ping",
  Effect.gen(function* () {
    const events = yield* AuthEvents.AuthEvents;
    yield* events.publish({ _tag: "auth.token.replay", identifier: "first" });
    yield* events.publish({ _tag: "auth.token.replay", identifier: "second" });
    return HttpServerResponse.empty({ status: 204 });
  }),
);

const Services = AuthEvents.layer.pipe(
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(NodeCrypto.layer),
);

const serve = Effect.gen(function* () {
  const context = yield* pingRoute.pipe(
    Layer.provide(RequestContext.layer),
    HttpRouter.serve,
    Layer.provideMerge(Services),
    Layer.build,
  );
  return Context.get(context, AuditLog.AuditLog);
});

describe("RequestContext (ALF-006)", () => {
  it.effect("x-request-id becomes the correlationId of every event the request raised", () =>
    Effect.gen(function* () {
      const auditLog = yield* serve;
      const response = yield* HttpClient.execute(
        HttpClientRequest.post("/ping").pipe(
          HttpClientRequest.setHeader("x-request-id", "r-1"),
          HttpClientRequest.setHeader("user-agent", "vitest/1"),
        ),
      );
      assert.strictEqual(response.status, 204);
      const rows = yield* auditLog.list();
      assert.strictEqual(rows.length, 2);
      for (const row of rows) {
        assert.deepStrictEqual(row.correlationId, Option.some("r-1"));
        assert.deepStrictEqual(row.userAgent, Option.some("vitest/1"));
        assert.isTrue(Option.isSome(row.ip));
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  // The test client propagates its own `traceparent`, so an end-to-end check of the
  // header fallback is unreliable; the precedence is pinned as a pure function.
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

  it.effect("every event one request raised shares one correlation id, even with no caller id", () =>
    Effect.gen(function* () {
      const auditLog = yield* serve;
      yield* HttpClient.execute(HttpClientRequest.post("/ping"));
      const rows = yield* auditLog.list();
      const ids = rows.map((row) => Option.getOrElse(row.correlationId, () => ""));
      assert.strictEqual(ids.length, 2);
      assert.notStrictEqual(ids[0], "");
      assert.strictEqual(ids[0], ids[1]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it("an unusable x-request-id is ignored, never stored", () => {
    const header = (value: string) => (name: string) => (name === "x-request-id" ? value : undefined);
    assert.deepStrictEqual(RequestContext.correlationIdFrom(header("has spaces")), Option.none());
    assert.deepStrictEqual(
      RequestContext.correlationIdFrom(header("x".repeat(129))),
      Option.none(),
    );
    assert.deepStrictEqual(RequestContext.correlationIdFrom(header("ok-1.2:3")), Option.some("ok-1.2:3"));
  });
});
