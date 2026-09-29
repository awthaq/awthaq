// BEH-EA-303/BEH-EA-306: `PinnedHttp` connects to the address a caller checked, keeps the registered name as Host and SNI,
// judges the address again, never follows a redirect, and reads a body only when asked, never beyond its cap.
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Http from "node:http";
import * as PinnedHttp from "../src/PinnedHttp.ts";

const request = (overrides: Partial<PinnedHttp.PinnedRequest> = {}): PinnedHttp.PinnedRequest => ({
  method: "POST",
  url: "https://hooks.example.com:8443/awthaq?x=1",
  headers: { "content-type": "application/json", "webhook-id": "e1" },
  body: '{"a":"é"}',
  pin: Option.some({ hostname: "hooks.example.com", address: "93.184.216.34", family: 4 }),
  allowPrivate: false,
  timeout: Duration.seconds(5),
  ...overrides,
});

describe("the pinned connection options", () => {
  it("connects to the IP literal and keeps the original name as Host and as the TLS server name", () => {
    const options = PinnedHttp.pinnedRequestOptions(request());
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

  it("an IP-literal URL sets no server name and defaults the port; a GET declares no length", () => {
    const options = PinnedHttp.pinnedRequestOptions(
      request({
        method: "GET",
        body: undefined,
        url: "https://93.184.216.34/hook",
        pin: Option.some({ hostname: "93.184.216.34", address: "93.184.216.34", family: 4 }),
      }),
    );
    if (options === "blocked" || options === "unpinned") return assert.fail("expected options");
    assert.isUndefined(options.servername);
    assert.strictEqual(options.port, 443);
    assert.notProperty(options.headers, "content-length");
  });

  it("refuses a private or metadata address handed to it, whatever the caller checked", () => {
    for (const address of ["169.254.169.254", "10.0.0.5", "127.0.0.1", "::1", "fd00::1"]) {
      const options = PinnedHttp.pinnedRequestOptions(
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
    const lifted = PinnedHttp.pinnedRequestOptions(
      request({
        allowPrivate: true,
        pin: Option.some({ hostname: "localhost", address: "127.0.0.1", family: 4 }),
      }),
    );
    assert.notStrictEqual(lifted, "blocked");
    assert.strictEqual(
      PinnedHttp.pinnedRequestOptions(request({ pin: Option.none() })),
      "unpinned",
    );
  });
});

type Seen = { host: string | undefined; body: string };

/** A local receiver: records what it saw and answers by `reply`. */
const withServer = <A, E, R>(
  reply: (request: Http.IncomingMessage, response: Http.ServerResponse) => void,
  use: (server: { readonly port: number; readonly seen: Array<Seen> }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly http: Http.Server; readonly seen: Array<Seen> }>((resolve) => {
          const seen: Array<Seen> = [];
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
      return use({
        port: typeof address === "object" && address !== null ? address.port : 0,
        seen,
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

const only = <A>(rows: ReadonlyArray<A>): A => {
  const [first] = rows;
  if (first === undefined || rows.length !== 1)
    throw new Error(`expected one row, got ${rows.length}`);
  return first;
};

describe("PinnedHttp.send on a real socket", () => {
  // The name does not resolve anywhere: only the pin can get this to the local server.
  const toLoopback = (port: number, overrides: Partial<PinnedHttp.PinnedRequest> = {}) =>
    PinnedHttp.send(
      request({
        url: `http://hooks.example.com:${port}/awthaq`,
        pin: Option.some({ hostname: "hooks.example.com", address: "127.0.0.1", family: 4 }),
        allowPrivate: true,
        ...overrides,
      }),
    );

  it.live("connects to the pinned address and says the registered name in Host", () =>
    withServer(
      (_incoming, outgoing) => outgoing.writeHead(200).end("x".repeat(100_000)),
      (server) =>
        Effect.gen(function* () {
          const response = yield* toLoopback(server.port);
          assert.strictEqual(response.status, 200);
          // The body was not asked for, so it is not read.
          assert.isUndefined(response.body);
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
            const response = yield* toLoopback(server.port);
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
          const failure = yield* toLoopback(server.port, { allowPrivate: false }).pipe(Effect.flip);
          assert.strictEqual(failure.failure, "blocked");
          assert.strictEqual(server.seen.length, 0);
        }),
    ),
  );

  it.live("a refused connection is the class `connect`, never a message", () =>
    Effect.gen(function* () {
      // Port 1 on loopback: nothing listens.
      const failure = yield* toLoopback(1).pipe(Effect.flip);
      assert.strictEqual(failure.failure, "connect");
      assert.deepStrictEqual(
        Object.keys(failure).filter((key) => key !== "failure" && key !== "_tag"),
        [],
      );
    }),
  );

  it.live("an attempt that gets no answer is `timeout`, and its socket is destroyed", () =>
    withServer(
      () => undefined,
      (server) =>
        Effect.gen(function* () {
          const failure = yield* toLoopback(server.port, { timeout: Duration.millis(100) }).pipe(
            Effect.flip,
          );
          assert.strictEqual(failure.failure, "timeout");
          assert.strictEqual(server.seen.length, 1);
        }),
    ),
  );

  it.live(
    "reads the body only when asked, up to the cap, and cuts off a longer one as `tooLarge`",
    () =>
      withServer(
        (_incoming, outgoing) => outgoing.writeHead(200).end("y".repeat(5_000)),
        (server) =>
          Effect.gen(function* () {
            const read = yield* toLoopback(server.port, {
              method: "GET",
              body: undefined,
              maxResponseBytes: 10_000,
            });
            assert.strictEqual(read.body?.length, 5_000);
            const capped = yield* toLoopback(server.port, {
              method: "GET",
              body: undefined,
              maxResponseBytes: 1_000,
            }).pipe(Effect.flip);
            assert.strictEqual(capped.failure, "tooLarge");
          }),
      ),
  );
});
