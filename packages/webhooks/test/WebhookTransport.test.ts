// BEH-EA-312 (spec/behaviors/34-webhooks.md): connection pinning against DNS rebinding. An attempt resolves the
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

describe("WebhookTransport.layerNodePinned", () => {
  // The generic pinning behaviour (Host/SNI, the address check, redirects, caps) is `PinnedHttp`'s, tested in @awthaq/ports;
  // this is the transport's own seam: the class it reports and that it reaches the pinned address.
  const send = (port: number, overrides: Partial<WebhookTransport.TransportRequest> = {}) =>
    Effect.flatMap(WebhookTransport.WebhookTransport, (transport) =>
      transport.send({
        url: `http://hooks.example.com:${port}/awthaq`,
        headers: { "content-type": "application/json" },
        body: "{}",
        pin: Option.some({ hostname: "hooks.example.com", address: "127.0.0.1", family: 4 }),
        allowPrivate: true,
        timeout: Duration.seconds(5),
        ...overrides,
      }),
    ).pipe(Effect.provide(WebhookTransport.layerNodePinned));

  const withServer = <A, E, R>(
    reply: (response: Http.ServerResponse) => void,
    use: (server: {
      readonly port: number;
      readonly hosts: Array<string | undefined>;
    }) => Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      Effect.promise(
        () =>
          new Promise<{ readonly http: Http.Server; readonly hosts: Array<string | undefined> }>(
            (resolve) => {
              const hosts: Array<string | undefined> = [];
              const http = Http.createServer((incoming, outgoing) => {
                hosts.push(incoming.headers.host);
                incoming.resume();
                reply(outgoing);
              });
              http.listen(0, "127.0.0.1", () => resolve({ http, hosts }));
            },
          ),
      ),
      ({ http, hosts }) => {
        const address = http.address();
        return use({
          port: typeof address === "object" && address !== null ? address.port : 0,
          hosts,
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

  it.live(
    "reaches the pinned address by the registered name and answers with the status only",
    () =>
      withServer(
        (response) => response.writeHead(204).end(),
        (server) =>
          Effect.gen(function* () {
            const response = yield* send(server.port);
            assert.deepStrictEqual(response, { status: 204 });
            assert.deepStrictEqual(server.hosts, [`hooks.example.com:${server.port}`]);
          }),
      ),
  );

  it.live("reports a private pinned address as `blocked` and a dead port as `connect`", () =>
    Effect.gen(function* () {
      const blocked = yield* send(1, { allowPrivate: false }).pipe(Effect.flip);
      assert.strictEqual(blocked.failure, "blocked");
      const refused = yield* send(1).pipe(Effect.flip);
      assert.strictEqual(refused.failure, "connect");
    }),
  );
});
