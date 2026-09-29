// BEH-EA-303 (spec/behaviors/34-webhooks.md): connection pinning against DNS rebinding. An attempt resolves the
// endpoint's host ONCE, judges every address, and the transport connects to that address with the original
// Host/SNI; the address is judged again at the connect; nothing is resolved twice.
import { HostResolver } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Http from "node:http";
import * as WebhookDelivery from "../src/WebhookDelivery.ts";
import * as WebhookRecords from "../src/WebhookRecords.ts";
import * as WebhookTransport from "../src/WebhookTransport.ts";
import { deliveryLayer, fakeTransport, published, seedEndpoint, signedIn } from "./support.ts";

/** A resolver that answers from a script, one answer per lookup, and counts the lookups. */
const scriptedResolver = (answers: ReadonlyArray<ReadonlyArray<string>>) => {
  let lookups = 0;
  const layer = Layer.succeed(
    HostResolver.HostResolver,
    HostResolver.HostResolver.of({
      resolve: () => {
        const answer = answers[Math.min(lookups, answers.length - 1)] ?? [];
        lookups += 1;
        return Effect.succeed(answer);
      },
    }),
  );
  return { layer, lookups: () => lookups };
};

const only = <A>(rows: ReadonlyArray<A>): A => {
  const [first] = rows;
  if (first === undefined || rows.length !== 1)
    throw new Error(`expected exactly one row, got ${rows.length}`);
  return first;
};

describe("an attempt pins the connection to the address it checked", () => {
  it.effect(
    "hands the transport the one resolved address, the URL keeping the registered name",
    () => {
      const resolver = scriptedResolver([["93.184.216.34", "2606:2800:220:1::1"]]);
      const transport = fakeTransport();
      return Effect.gen(function* () {
        yield* seedEndpoint({ url: "https://hooks.example.com:8443/awthaq" });
        yield* WebhookDelivery.enqueue([yield* published(signedIn())]);
        yield* WebhookDelivery.drainDue;
        const request = only(transport.sent);
        assert.strictEqual(request.url, "https://hooks.example.com:8443/awthaq");
        assert.deepStrictEqual(
          request.pin,
          Option.some({
            hostname: "hooks.example.com",
            address: "93.184.216.34",
            family: 4,
          }),
        );
        assert.isFalse(request.allowPrivate);
        // Resolved once for the attempt, not once to check and once again to connect.
        assert.strictEqual(resolver.lookups(), 1);
      }).pipe(
        Effect.provide(deliveryLayer({ transport: transport.layer, resolver: resolver.layer })),
      );
    },
  );

  it.effect(
    "a name that flips to a private address between attempts is pinned public first and refused second, never sent",
    () => {
      const resolver = scriptedResolver([["93.184.216.34"], ["169.254.169.254"]]);
      const transport = fakeTransport(() => Effect.succeed({ status: 500 }));
      return Effect.gen(function* () {
        const { endpoint } = yield* seedEndpoint();
        const records = yield* WebhookRecords.WebhookRecords;
        yield* WebhookDelivery.enqueue([yield* published(signedIn())]);
        yield* WebhookDelivery.drainDue;
        assert.strictEqual(transport.sent.length, 1);
        // The retry: the name now answers with the cloud metadata address.
        const [row] = yield* records.listDeliveries({ endpointId: endpoint.id, limit: 5 });
        if (row === undefined) return assert.fail("no delivery");
        yield* records.defer(row.id, row.createdAt);
        yield* WebhookDelivery.drainDue;
        assert.strictEqual(transport.sent.length, 1, "the rebound address was never contacted");
        const after = Option.getOrThrow(yield* records.findDelivery(row.id));
        assert.deepStrictEqual(after.lastError, Option.some("blocked"));
        assert.strictEqual(resolver.lookups(), 2);
      }).pipe(
        Effect.provide(deliveryLayer({ transport: transport.layer, resolver: resolver.layer })),
      );
    },
  );

  it.effect(
    "re-resolves on every attempt: each attempt is pinned to what the name answered THEN",
    () => {
      const resolver = scriptedResolver([["93.184.216.34"], ["93.184.216.99"]]);
      const transport = fakeTransport(() => Effect.succeed({ status: 500 }));
      return Effect.gen(function* () {
        const { endpoint } = yield* seedEndpoint();
        const records = yield* WebhookRecords.WebhookRecords;
        yield* WebhookDelivery.enqueue([yield* published(signedIn())]);
        yield* WebhookDelivery.drainDue;
        const [row] = yield* records.listDeliveries({ endpointId: endpoint.id, limit: 5 });
        if (row === undefined) return assert.fail("no delivery");
        yield* records.defer(row.id, row.createdAt);
        yield* WebhookDelivery.drainDue;
        assert.deepStrictEqual(
          transport.sent.map((request) => Option.getOrUndefined(request.pin)?.address),
          ["93.184.216.34", "93.184.216.99"],
        );
      }).pipe(
        Effect.provide(deliveryLayer({ transport: transport.layer, resolver: resolver.layer })),
      );
    },
  );

  it.effect(
    "one private answer among several public ones refuses the attempt before any connection",
    () => {
      const resolver = scriptedResolver([["93.184.216.34", "10.0.0.7"]]);
      const transport = fakeTransport();
      return Effect.gen(function* () {
        const { endpoint } = yield* seedEndpoint();
        const records = yield* WebhookRecords.WebhookRecords;
        yield* WebhookDelivery.enqueue([yield* published(signedIn())]);
        yield* WebhookDelivery.drainDue;
        assert.strictEqual(transport.sent.length, 0);
        const [row] = yield* records.listDeliveries({ endpointId: endpoint.id, limit: 5 });
        assert.deepStrictEqual(row?.lastError, Option.some("blocked"));
      }).pipe(
        Effect.provide(deliveryLayer({ transport: transport.layer, resolver: resolver.layer })),
      );
    },
  );

  it.effect(
    "development mode (allowPrivateTargets) sends unpinned, with private addresses allowed",
    () => {
      const transport = fakeTransport();
      return Effect.gen(function* () {
        yield* seedEndpoint({ url: "http://localhost:3000/hook" });
        yield* WebhookDelivery.enqueue([yield* published(signedIn())]);
        yield* WebhookDelivery.drainDue;
        const request = only(transport.sent);
        assert.isTrue(Option.isNone(request.pin));
        assert.isTrue(request.allowPrivate);
      }).pipe(
        Effect.provide(
          deliveryLayer({ transport: transport.layer, config: { allowPrivateTargets: true } }),
        ),
      );
    },
  );

  it.effect("a transport failure class is what the log records", () => {
    const transport = fakeTransport(() =>
      Effect.fail(new WebhookTransport.WebhookTransportError({ failure: "blocked" })),
    );
    return Effect.gen(function* () {
      const { endpoint } = yield* seedEndpoint();
      const records = yield* WebhookRecords.WebhookRecords;
      yield* WebhookDelivery.enqueue([yield* published(signedIn())]);
      yield* WebhookDelivery.drainDue;
      const [row] = yield* records.listDeliveries({ endpointId: endpoint.id, limit: 5 });
      assert.deepStrictEqual(row?.lastError, Option.some("blocked"));
    }).pipe(Effect.provide(deliveryLayer({ transport: transport.layer })));
  });
});

const request = (overrides: Partial<WebhookTransport.TransportRequest> = {}) => ({
  url: "https://hooks.example.com:8443/awthaq?x=1",
  headers: { "content-type": "application/json", "webhook-id": "e1" },
  body: '{"a":"é"}',
  pin: Option.some({ hostname: "hooks.example.com", address: "93.184.216.34", family: 4 as const }),
  allowPrivate: false,
  timeout: Duration.seconds(5),
  ...overrides,
});

describe("the pinned connection options", () => {
  it("connects to the IP literal and keeps the original name as Host and as the TLS server name", () => {
    const options = WebhookTransport.pinnedRequestOptions(request());
    if (options === "blocked" || options === "unpinned") return assert.fail("expected options");
    assert.strictEqual(options.host, "93.184.216.34");
    assert.strictEqual(options.port, 8443);
    assert.strictEqual(options.path, "/awthaq?x=1");
    assert.strictEqual(options.servername, "hooks.example.com");
    assert.strictEqual(options.headers["host"], "hooks.example.com:8443");
    // The declared length is the encoded byte length, not the character count.
    assert.strictEqual(options.headers["content-length"], "10");
    assert.strictEqual(options.headers["webhook-id"], "e1");
    assert.isTrue(options.secure);
  });

  it("an IP-literal URL sets no server name and defaults the port", () => {
    const options = WebhookTransport.pinnedRequestOptions(
      request({
        url: "https://93.184.216.34/hook",
        pin: Option.some({ hostname: "93.184.216.34", address: "93.184.216.34", family: 4 }),
      }),
    );
    if (options === "blocked" || options === "unpinned") return assert.fail("expected options");
    assert.isUndefined(options.servername);
    assert.strictEqual(options.port, 443);
  });

  it("refuses a private or metadata address handed to it, whatever the caller checked", () => {
    for (const address of ["169.254.169.254", "10.0.0.5", "127.0.0.1", "::1", "fd00::1"]) {
      const options = WebhookTransport.pinnedRequestOptions(
        request({
          pin: Option.some({
            hostname: "hooks.example.com",
            address,
            family: address.includes(":") ? 6 : 4,
          }),
        }),
      );
      assert.strictEqual(options, "blocked", address);
    }
  });

  it("allowPrivate lifts the address check (development only); no pin means an ordinary connection", () => {
    const lifted = WebhookTransport.pinnedRequestOptions(
      request({
        allowPrivate: true,
        pin: Option.some({ hostname: "localhost", address: "127.0.0.1", family: 4 }),
      }),
    );
    assert.notStrictEqual(lifted, "blocked");
    assert.strictEqual(
      WebhookTransport.pinnedRequestOptions(request({ pin: Option.none() })),
      "unpinned",
    );
  });
});

/** A local receiver: records what it saw and answers by `reply`. */
const withServer = <A, E, R>(
  reply: (request: Http.IncomingMessage, response: Http.ServerResponse) => void,
  use: (server: {
    readonly port: number;
    readonly seen: Array<{ host: string | undefined; body: string }>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(
      () =>
        new Promise<{
          readonly http: Http.Server;
          readonly seen: Array<{ host: string | undefined; body: string }>;
        }>((resolve) => {
          const seen: Array<{ host: string | undefined; body: string }> = [];
          const http = Http.createServer((incoming, outgoing) => {
            const chunks: Array<Buffer> = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.on("end", () => {
              seen.push({
                host: incoming.headers.host,
                body: Buffer.concat(chunks).toString("utf8"),
              });
              reply(incoming, outgoing);
            });
          });
          http.listen(0, "127.0.0.1", () => resolve({ http, seen }));
        }),
    ),
    ({ http, seen }) => {
      const address = http.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      return use({ port, seen });
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

describe("layerNodePinned on a real socket", () => {
  const send = (port: number, overrides: Partial<WebhookTransport.TransportRequest> = {}) =>
    Effect.flatMap(WebhookTransport.WebhookTransport, (transport) =>
      transport.send(
        request({
          // The name does not resolve anywhere: only the pin can get this to the local server.
          url: `http://hooks.example.com:${port}/awthaq`,
          pin: Option.some({ hostname: "hooks.example.com", address: "127.0.0.1", family: 4 }),
          allowPrivate: true,
          ...overrides,
        }),
      ),
    ).pipe(Effect.provide(WebhookTransport.layerNodePinned));

  it.live("connects to the pinned address and says the registered name in Host", () =>
    withServer(
      (_incoming, outgoing) => outgoing.writeHead(200).end("x".repeat(100_000)),
      (server) =>
        Effect.gen(function* () {
          const response = yield* send(server.port);
          assert.strictEqual(response.status, 200);
          const seen = only(server.seen);
          assert.strictEqual(seen.host, `hooks.example.com:${server.port}`);
          assert.strictEqual(seen.body, '{"a":"é"}');
        }),
    ),
  );

  it.live(
    "does not follow a redirect: the 3xx is the answer and the target is never contacted",
    () =>
      withServer(
        (_incoming, outgoing) =>
          outgoing.writeHead(302, { location: "http://169.254.169.254/" }).end(),
        (server) =>
          Effect.gen(function* () {
            const response = yield* send(server.port);
            assert.strictEqual(response.status, 302);
            assert.strictEqual(server.seen.length, 1);
          }),
      ),
  );

  it.live("refuses a private pinned address without opening a connection", () =>
    withServer(
      (_incoming, outgoing) => outgoing.writeHead(200).end(),
      (server) =>
        Effect.gen(function* () {
          const failure = yield* send(server.port, { allowPrivate: false }).pipe(Effect.flip);
          assert.strictEqual(failure.failure, "blocked");
          assert.strictEqual(server.seen.length, 0);
        }),
    ),
  );

  it.live("a refused connection is the class `connect`, never a message", () =>
    Effect.gen(function* () {
      // Port 1 on loopback: nothing listens.
      const failure = yield* send(1).pipe(Effect.flip);
      assert.strictEqual(failure.failure, "connect");
      assert.deepStrictEqual(
        Object.keys(failure).filter((key) => key !== "failure" && key !== "_tag"),
        [],
      );
    }),
  );

  it.live("an interrupted attempt destroys the socket", () =>
    withServer(
      () => undefined,
      (server) =>
        Effect.gen(function* () {
          const outcome = yield* send(server.port).pipe(Effect.timeoutOption(Duration.millis(100)));
          assert.isTrue(Option.isNone(outcome));
          assert.strictEqual(server.seen.length, 1);
        }),
    ),
  );
});
