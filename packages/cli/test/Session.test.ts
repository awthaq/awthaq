// BEH-EA-227 (CTA-001, CTA-002, DAG-002, CTA-005): `login`, `logout` and `whoami` against a REAL auth
// server on a real socket (`test/support/TestServer.ts`: core's session group, real handlers,
// real bearer authentication and CSRF), through the real command tree and the generated
// `HttpApiClient`. The credential store is the in-memory one — a test never touches the keychain.
import { Api } from "@awthaq/api";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it, vi } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as net from "node:net";
import * as http from "node:http";
import { memoryCredentials, runCli, withEnvOverride } from "./support/RunCli.ts";
import { serveAuth } from "./support/TestServer.ts";

const withEnv = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

const everything = (result: {
  readonly stdout: ReadonlyArray<string>;
  readonly stderr: ReadonlyArray<string>;
}) => [...result.stdout, ...result.stderr].join("\n");

describe("login --token", () => {
  it.effect("validates the token against the server, stores it, and prints no secret", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveAuth();
        const { token, sessionId } = yield* server.issue("ada@example.com");
        const creds = yield* memoryCredentials();
        const result = yield* runCli(
          ["login", "--token", token, "--base-url", server.baseUrl],
          undefined,
          { credentials: creds.layer },
        );
        assert.strictEqual(result.code, 0);
        assert.include(everything(result), sessionId);
        assert.notInclude(everything(result), token);
        const stored = yield* Ref.get(creds.ref);
        assert.isTrue(Option.isSome(stored));
        if (Option.isNone(stored)) return;
        assert.strictEqual(stored.value.baseUrl, server.baseUrl);
        assert.strictEqual(Redacted.value(stored.value.token), token);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects an invalid token (exit 8) and stores nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveAuth();
        const creds = yield* memoryCredentials();
        const result = yield* runCli(
          ["login", "--token", "not-a-real-token", "--base-url", server.baseUrl],
          undefined,
          { credentials: creds.layer },
        );
        assert.strictEqual(result.code, 8);
        assert.strictEqual(yield* Ref.get(creds.writes), 0);
        assert.isTrue(Option.isNone(yield* Ref.get(creds.ref)));
        assert.notInclude(everything(result), "not-a-real-token");
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("AWTHAQ_TOKEN and AWTHAQ_BASE_URL make it fully non-interactive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveAuth();
        const { token } = yield* server.issue("grace@example.com");
        const creds = yield* memoryCredentials();
        const result = yield* runCli(["login"], undefined, { credentials: creds.layer }).pipe(
          withEnv({ AWTHAQ_TOKEN: token, AWTHAQ_BASE_URL: server.baseUrl }),
        );
        assert.strictEqual(result.code, 0);
        assert.strictEqual(yield* Ref.get(creds.writes), 1);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("needs to know the server: no --base-url and none stored is a usage error", () =>
    Effect.gen(function* () {
      const result = yield* runCli(["login", "--token", "t"]);
      assert.strictEqual(result.code, 2);
    }),
  );

  it.effect("a malformed --base-url is a usage error before anything is contacted", () =>
    Effect.gen(function* () {
      const result = yield* runCli(["login", "--token", "t", "--base-url", "ftp://nope"]);
      assert.strictEqual(result.code, 2);
    }),
  );

  it.effect("an unreachable server is exit 9, not a crash", () =>
    Effect.gen(function* () {
      const result = yield* runCli(["login", "--token", "t", "--base-url", "http://127.0.0.1:1"]);
      assert.strictEqual(result.code, 9);
    }),
  );
});

describe("whoami", () => {
  it.effect(
    "prints the stored credential's session (and never the token); --json is one document",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveAuth();
          const { token, sessionId } = yield* server.issue("ada@example.com");
          const creds = yield* memoryCredentials({
            baseUrl: server.baseUrl,
            token: Redacted.make(token),
          });
          const text = yield* runCli(["whoami"], undefined, { credentials: creds.layer });
          assert.strictEqual(text.code, 0);
          assert.include(everything(text), sessionId);
          assert.notInclude(everything(text), token);
          const json = yield* runCli(["whoami", "--json"], undefined, { credentials: creds.layer });
          assert.strictEqual(json.code, 0);
          const doc = JSON.parse(json.stdout.join("\n"));
          assert.strictEqual(doc.sessionId, sessionId);
          assert.strictEqual(doc.baseUrl, server.baseUrl);
          assert.notInclude(json.stdout.join("\n"), token);
        }),
      ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("exits 8 when not logged in", () =>
    Effect.gen(function* () {
      const result = yield* runCli(["whoami"]);
      assert.strictEqual(result.code, 8);
      assert.include(everything(result), "not logged in");
    }),
  );

  it.effect("exits 8 when the server has revoked the session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveAuth();
        const { token, userId } = yield* server.issue("ada@example.com");
        yield* server.revokeAll(userId);
        const creds = yield* memoryCredentials({
          baseUrl: server.baseUrl,
          token: Redacted.make(token),
        });
        const result = yield* runCli(["whoami"], undefined, { credentials: creds.layer });
        assert.strictEqual(result.code, 8);
        assert.include(everything(result), "rejected the token");
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("AWTHAQ_TOKEN wins over the stored credential and is never persisted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveAuth();
        const stored = yield* server.issue("stored@example.com");
        const envUser = yield* server.issue("env@example.com");
        const creds = yield* memoryCredentials({
          baseUrl: server.baseUrl,
          token: Redacted.make(stored.token),
        });
        const result = yield* runCli(["whoami", "--json"], undefined, {
          credentials: withEnvOverride(creds.layer),
        }).pipe(withEnv({ AWTHAQ_TOKEN: envUser.token, AWTHAQ_BASE_URL: server.baseUrl }));
        assert.strictEqual(result.code, 0);
        // The credential the environment named — not the stored one — was used ...
        assert.strictEqual(JSON.parse(result.stdout.join("\n")).sessionId, envUser.sessionId);
        assert.notStrictEqual(envUser.sessionId, stored.sessionId);
        // ... and nothing was written to the store.
        assert.strictEqual(yield* Ref.get(creds.writes), 0);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("persists a token the server rotated (there is no grace window)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rotated = "rotated-token-abc";
        const server = http.createServer((_request, response) => {
          response.writeHead(200, {
            "content-type": "application/json",
            [Api.ROTATED_TOKEN_HEADER]: rotated,
          });
          response.end(
            JSON.stringify({
              id: "s-1",
              createdAt: "2026-01-01T00:00:00.000Z",
              lastActiveAt: "2026-01-01T00:00:00.000Z",
              expiresAt: "2027-01-01T00:00:00.000Z",
              userAgent: null,
              amr: [],
              current: true,
            }),
          );
        });
        yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.listen(0, "127.0.0.1", () => resolve());
              }),
          ),
          () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        );
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const creds = yield* memoryCredentials({
          baseUrl: `http://127.0.0.1:${port}`,
          token: Redacted.make("old-token"),
        });
        const result = yield* runCli(["whoami"], undefined, { credentials: creds.layer });
        assert.strictEqual(result.code, 0);
        const stored = yield* Ref.get(creds.ref);
        assert.strictEqual(
          Option.isSome(stored) ? Redacted.value(stored.value.token) : "",
          rotated,
        );
      }),
    ),
  );
});

describe("logout", () => {
  it.effect("clears the credential and revokes the session on the server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveAuth();
        const { token } = yield* server.issue("ada@example.com");
        const creds = yield* memoryCredentials({
          baseUrl: server.baseUrl,
          token: Redacted.make(token),
        });
        const result = yield* runCli(["logout"], undefined, { credentials: creds.layer });
        assert.strictEqual(result.code, 0);
        assert.isTrue(Option.isNone(yield* Ref.get(creds.ref)));
        // The token is dead server-side too: presenting it again is rejected.
        const again = yield* runCli(["whoami"], undefined, {
          credentials: (yield* memoryCredentials({
            baseUrl: server.baseUrl,
            token: Redacted.make(token),
          })).layer,
        });
        assert.strictEqual(again.code, 8);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("clears locally even when the server cannot be reached, and says so", () =>
    Effect.gen(function* () {
      const creds = yield* memoryCredentials({
        baseUrl: "http://127.0.0.1:1",
        token: Redacted.make("t"),
      });
      const result = yield* runCli(["logout"], undefined, { credentials: creds.layer });
      assert.strictEqual(result.code, 0);
      assert.isTrue(Option.isNone(yield* Ref.get(creds.ref)));
      assert.include(everything(result), "could not revoke the session on the server");
    }),
  );

  it.effect("is idempotent when nobody is logged in", () =>
    Effect.gen(function* () {
      const result = yield* runCli(["logout"]);
      assert.strictEqual(result.code, 0);
      assert.include(everything(result), "not logged in");
    }),
  );
});

// BEH-EA-208 class 3: a session command is an outbound client only. If any of them ever bound a
// socket (a loopback callback for a browser flow, say), `Server.listen` would be called.
describe("session commands never start a listener (BEH-EA-208)", () => {
  it.effect("login, whoami and logout call no Server.listen", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveAuth();
        const { token } = yield* server.issue("ada@example.com");
        const listen = vi.spyOn(net.Server.prototype, "listen");
        try {
          const creds = yield* memoryCredentials();
          yield* runCli(["login", "--token", token, "--base-url", server.baseUrl], undefined, {
            credentials: creds.layer,
          });
          yield* runCli(["whoami"], undefined, { credentials: creds.layer });
          yield* runCli(["logout"], undefined, { credentials: creds.layer });
          assert.strictEqual(listen.mock.calls.length, 0);
        } finally {
          listen.mockRestore();
        }
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
