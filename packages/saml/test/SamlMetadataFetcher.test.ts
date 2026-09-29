// BEH-EA-309: fetching IdP metadata from a URL an administrator supplied is an SSRF surface, so it is guarded like a webhook endpoint:
// `OutboundUrl` first, the host resolved ONCE and every answer required to be public, the connection pinned to that address
// (`PinnedHttp`, tested in `@awthaq/ports`), no redirect followed, the body capped, the deadline bounded, and failures as CLASSES.
import { HostResolver } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Http from "node:http";
import * as Saml from "../src/Saml.ts";
import * as SamlMetadataFetcher from "../src/SamlMetadataFetcher.ts";
import { BASE_URL } from "./support.ts";

const fetcherLayer = (
  config: Partial<Omit<Saml.SamlConfigInput, "baseUrl">>,
  table: Readonly<Record<string, ReadonlyArray<string>>> = {},
) =>
  SamlMetadataFetcher.layerPinned.pipe(
    Layer.provide(Saml.config({ baseUrl: BASE_URL, ...config })),
    Layer.provide(HostResolver.layerStatic(table)),
  );

const failureOf = (url: string) =>
  Effect.flatMap(SamlMetadataFetcher.SamlMetadataFetcher, (fetcher) => fetcher.fetch(url)).pipe(
    Effect.flip,
    Effect.map((error) => error.failure),
  );

const withServer = <A, E, R>(
  reply: (request: Http.IncomingMessage, response: Http.ServerResponse) => void,
  use: (server: {
    readonly port: number;
    readonly hits: Array<string | undefined>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly http: Http.Server; readonly hits: Array<string | undefined> }>(
          (resolve) => {
            const hits: Array<string | undefined> = [];
            const http = Http.createServer((incoming, outgoing) => {
              hits.push(incoming.headers.host);
              reply(incoming, outgoing);
            });
            http.listen(0, "127.0.0.1", () => resolve({ http, hits }));
          },
        ),
    ),
    ({ http, hits }) => {
      const address = http.address();
      return use({
        port: typeof address === "object" && address !== null ? address.port : 0,
        hits,
      });
    },
    ({ http }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            http.closeAllConnections();
            http.close(() => resolve());
          }),
      ),
  );

describe("the URL is judged before any request", () => {
  it.effect(
    "http, credentials, private literals, internal names and single-label hosts are `invalidUrl`",
    () =>
      Effect.gen(function* () {
        for (const url of [
          "http://idp.example.com/metadata",
          "https://user:pw@idp.example.com/metadata",
          "https://169.254.169.254/latest/meta-data",
          "https://127.0.0.1/metadata",
          "https://[::1]/metadata",
          "https://localhost/metadata",
          "https://idp.internal/metadata",
          "https://intranet/metadata",
          "not a url",
        ]) {
          assert.strictEqual(yield* failureOf(url), "invalidUrl", url);
        }
      }).pipe(Effect.provide(fetcherLayer({}))),
  );

  it.effect(
    "a public-looking name that resolves to a private address, to one private among several, or to nothing is `blocked`",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* failureOf("https://rebind.example.com/metadata"), "blocked");
        assert.strictEqual(yield* failureOf("https://mixed.example.com/metadata"), "blocked");
        assert.strictEqual(yield* failureOf("https://nx.example.com/metadata"), "blocked");
      }).pipe(
        Effect.provide(
          fetcherLayer(
            {},
            {
              "rebind.example.com": ["169.254.169.254"],
              "mixed.example.com": ["93.184.216.34", "10.0.0.7"],
            },
          ),
        ),
      ),
  );
});

describe("the request, once the URL is allowed (development mode reaches loopback)", () => {
  const dev = fetcherLayer({
    allowPrivateTargets: true,
    maxMetadataBytes: 4_000,
    metadataTimeout: Duration.millis(300),
  });
  const get = (port: number, path = "/metadata") =>
    Effect.flatMap(SamlMetadataFetcher.SamlMetadataFetcher, (fetcher) =>
      fetcher.fetch(`http://localhost:${port}${path}`),
    );

  it.live("returns the body of a 200", () =>
    withServer(
      (_request, response) =>
        response
          .writeHead(200, { "content-type": "application/samlmetadata+xml" })
          .end("<md:EntityDescriptor/>"),
      (server) =>
        Effect.gen(function* () {
          assert.strictEqual(yield* get(server.port), "<md:EntityDescriptor/>");
          assert.strictEqual(server.hits.length, 1);
        }),
    ).pipe(Effect.provide(dev)),
  );

  it.live(
    "anything but 200 is `status`; a redirect is not followed (the target is never contacted)",
    () =>
      withServer(
        (request, response) =>
          request.url === "/moved"
            ? response.writeHead(302, { location: "http://169.254.169.254/latest" }).end()
            : response.writeHead(404).end("no such metadata"),
        (server) =>
          Effect.gen(function* () {
            const missing = yield* get(server.port).pipe(Effect.flip);
            assert.strictEqual(missing.failure, "status");
            const moved = yield* get(server.port, "/moved").pipe(Effect.flip);
            assert.strictEqual(moved.failure, "status");
            assert.strictEqual(server.hits.length, 2, "nothing followed the redirect");
            // What the far end said is never part of the error.
            assert.notInclude(JSON.stringify(missing), "no such metadata");
          }),
      ).pipe(Effect.provide(dev)),
  );

  it.live("a body over the cap is `tooLarge`, cut off rather than buffered", () =>
    withServer(
      (_request, response) => response.writeHead(200).end("x".repeat(50_000)),
      (server) =>
        Effect.gen(function* () {
          const large = yield* get(server.port).pipe(Effect.flip);
          assert.strictEqual(large.failure, "tooLarge");
        }),
    ).pipe(Effect.provide(dev)),
  );

  it.live("a server that never answers is `timeout`, and a dead port is `connect`", () =>
    withServer(
      () => undefined,
      (server) =>
        Effect.gen(function* () {
          const slow = yield* get(server.port).pipe(Effect.flip);
          assert.strictEqual(slow.failure, "timeout");
          const dead = yield* get(1).pipe(Effect.flip);
          assert.strictEqual(dead.failure, "connect");
        }),
    ).pipe(Effect.provide(dev)),
  );
});
