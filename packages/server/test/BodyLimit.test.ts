// NHS-004: the default request-body cap on the serving path
// (spec/behaviors/11-http-error-mapping.md, BEH-EA-083/085). Exercised against
// a real Node HTTP server (the path where Effect's `MaxBodySize` reference is
// honored while reading) and against `toWebHandler` (BEH-EA-085's Fetch-native
// path, where the runtime does not read it, so the middleware's own
// `content-length` check is what holds).
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as http from "node:http";
import * as NetAddress from "effect/unstable/net/NetAddress";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as BodyLimit from "../src/BodyLimit.ts";

const oneMiB = JSON.stringify({ padding: "x".repeat(1024 * 1024) });
const small = JSON.stringify({ hello: "world" });

/** A POST route that counts the requests whose JSON body it read to the end. */
const echoRoute = (reached: Ref.Ref<number>) =>
  HttpRouter.add(
    "POST",
    "/echo",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      yield* request.json;
      yield* Ref.update(reached, (n) => n + 1);
      return HttpServerResponse.empty({ status: 204 });
    }),
  );

const jsonBody = (text: string) =>
  HttpBody.text(text, "application/json");

describe("BodyLimit (real Node server, NHS-004)", () => {
  it.effect("a 1 MiB JSON body returns 413 and never reaches the handler", () =>
    Effect.gen(function* () {
      const reached = yield* Ref.make(0);
      yield* echoRoute(reached).pipe(
        Layer.provide(BodyLimit.layer),
        HttpRouter.serve,
        Layer.build,
      );
      const response = yield* HttpClient.post("/echo", { body: jsonBody(oneMiB) });
      assert.strictEqual(response.status, 413);
      const body = yield* response.json;
      assert.deepStrictEqual(body, {
        _tag: "PayloadTooLarge",
        message: "awthaq: request body exceeds 262144 bytes",
      });
      assert.strictEqual(yield* Ref.get(reached), 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("a normal payload still succeeds", () =>
    Effect.gen(function* () {
      const reached = yield* Ref.make(0);
      yield* echoRoute(reached).pipe(
        Layer.provide(BodyLimit.layer),
        HttpRouter.serve,
        Layer.build,
      );
      const response = yield* HttpClient.post("/echo", { body: jsonBody(small) });
      assert.strictEqual(response.status, 204);
      assert.strictEqual(yield* Ref.get(reached), 1);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("a streamed body with no content-length is cut off at the cap", () =>
    Effect.gen(function* () {
      const reached = yield* Ref.make(0);
      yield* echoRoute(reached).pipe(
        Layer.provide(BodyLimit.layer),
        HttpRouter.serve,
        Layer.build,
      );
      const server = yield* HttpServer.HttpServer;
      assert.isTrue(NetAddress.isInetAddress(server.address));
      if (!NetAddress.isInetAddress(server.address)) return;
      const port = server.address.port;
      // A raw chunked request: no `content-length`, so only the body reader's own cap can stop it.
      // Effect's body reader destroys the socket once the cap is crossed, so the
      // client normally sees the connection drop rather than a 413 response.
      const outcome = yield* Effect.promise(
        () =>
          new Promise<number | "connection dropped">((resolve) => {
            const request = http.request(
              {
                host: "127.0.0.1",
                port,
                path: "/echo",
                method: "POST",
                headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
              },
              (response) => {
                response.resume();
                resolve(response.statusCode ?? 0);
              },
            );
            request.on("error", () => resolve("connection dropped"));
            for (let i = 0; i < 16; i++) request.write("x".repeat(64 * 1024));
            request.end();
          }),
      );
      assert.isTrue(outcome === 413 || outcome === "connection dropped");
      assert.strictEqual(yield* Ref.get(reached), 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("the cap is configurable per deployment", () =>
    Effect.gen(function* () {
      const reached = yield* Ref.make(0);
      yield* echoRoute(reached).pipe(
        Layer.provide(BodyLimit.layer),
        Layer.provide(BodyLimit.config({ maxBytes: ByteSize.bytes(8) })),
        HttpRouter.serve,
        Layer.build,
      );
      const response = yield* HttpClient.post("/echo", { body: jsonBody(small) });
      assert.strictEqual(response.status, 413);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});

describe("BodyLimit (toWebHandler, BEH-EA-085)", () => {
  const webLayer = (reached: Ref.Ref<number>) =>
    Layer.mergeAll(echoRoute(reached), BodyLimit.layer).pipe(
      Layer.provideMerge(HttpRouter.layer),
    );

  it.effect("rejects an oversize content-length with 413 before the handler runs", () =>
    Effect.gen(function* () {
      const reached = yield* Ref.make(0);
      const { handler, dispose } = HttpRouter.toWebHandler(webLayer(reached));
      const response = yield* Effect.promise(() =>
        handler(
          new Request("http://localhost/echo", {
            method: "POST",
            // A Fetch-native host supplies `content-length` with the Request; a bare `Request` doesn't.
            headers: {
              "content-type": "application/json",
              "content-length": String(oneMiB.length),
            },
            body: oneMiB,
          }),
        ),
      );
      assert.strictEqual(response.status, 413);
      assert.strictEqual(yield* Ref.get(reached), 0);
      yield* Effect.promise(dispose);
    }),
  );

  it.effect("lets a normal payload through", () =>
    Effect.gen(function* () {
      const reached = yield* Ref.make(0);
      const { handler, dispose } = HttpRouter.toWebHandler(webLayer(reached));
      const response = yield* Effect.promise(() =>
        handler(
          new Request("http://localhost/echo", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: small,
          }),
        ),
      );
      assert.strictEqual(response.status, 204);
      yield* Effect.promise(dispose);
    }),
  );
});
