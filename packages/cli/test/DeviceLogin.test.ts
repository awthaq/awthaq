// BEH-EA-307 (DAG-002, CTA-001; spec/models/13-device-authorization.md): the interactive `login` — the
// OAuth 2.0 Device Authorization Grant — against a REAL auth server on a real socket
// (`test/support/TestServer.ts`: core's session group plus the real `@awthaq/device-authorization`
// plugin, real handlers, real bearer authentication), through the real command tree and the generated
// `HttpApiClient`. The person on the second device is the test, deciding through the plugin's own
// service inside the poll's pacing hook; time is `TestClock`, so a whole login takes milliseconds.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as Browser from "../src/Browser.ts";
import { memoryCredentials, runCli } from "./support/RunCli.ts";
import { serveAuth } from "./support/TestServer.ts";

const everything = (result: {
  readonly stdout: ReadonlyArray<string>;
  readonly stderr: ReadonlyArray<string>;
}) => [...result.stdout, ...result.stderr].join("\n");

/** The `XXXX-XXXX` code the command printed, once it has printed one. */
const printedCode = (stderr: ReadonlyArray<string>) =>
  /confirm the code ([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})/.exec(
    stderr.join("\n"),
  )?.[1];

/** A browser that records what it is asked to open. */
const recordingBrowser = Effect.gen(function* () {
  const opened = yield* Ref.make<ReadonlyArray<string>>([]);
  const layer = Layer.succeed(
    Browser.Browser,
    Browser.Browser.of({
      open: (url) => Ref.update(opened, (all) => [...all, url]).pipe(Effect.as(true)),
    }),
  );
  return { opened, layer };
});

describe("login (the device authorization flow)", () => {
  it.effect(
    "prints the code and URL, opens the browser, polls at the advised interval, and stores the session the server issues",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveAuth();
          const creds = yield* memoryCredentials();
          const browser = yield* recordingBrowser;
          const stderr: Array<string> = [];
          const sleeps: Array<number> = [];
          const result = yield* runCli(["login", "--base-url", server.baseUrl], undefined, {
            credentials: creds.layer,
            browser: browser.layer,
            stderr,
            pacing: {
              sleep: (duration) =>
                Effect.gen(function* () {
                  sleeps.push(Duration.toSeconds(duration));
                  // The person approves during the third wait; the first two polls are pending.
                  const code = printedCode(stderr);
                  if (sleeps.length === 3 && code !== undefined) {
                    yield* server.decide(code, "ada@example.com");
                  }
                  yield* TestClock.adjust(duration);
                }),
            },
          });
          assert.strictEqual(result.code, 0, everything(result));
          // The request: the interval the server advised, kept while the grant stayed pending.
          assert.deepStrictEqual(sleeps, [5, 5, 5]);
          // The instructions are stderr; the verification page was opened in the browser.
          const url = "https://app.test/device?user_code=";
          assert.include(stderr.join("\n"), url);
          assert.strictEqual((yield* Ref.get(browser.opened)).length, 1);
          assert.include((yield* Ref.get(browser.opened))[0] ?? "", url);
          // A session was issued for the approving user and stored, and nothing secret was printed.
          const stored = yield* Ref.get(creds.ref);
          assert.isTrue(Option.isSome(stored));
          if (Option.isNone(stored)) return;
          assert.strictEqual(stored.value.baseUrl, server.baseUrl);
          assert.notInclude(everything(result), Redacted.value(stored.value.token));
          assert.include(result.stdout.join("\n"), "logged in to");
          // ...and it is a normal session: `whoami` accepts the stored token.
          const whoami = yield* runCli(["whoami"], undefined, {
            credentials: creds.layer,
          });
          assert.strictEqual(whoami.code, 0, everything(whoami));
        }),
      ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "--no-browser never opens a browser, and --json keeps stdout for the one result document",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveAuth();
          const creds = yield* memoryCredentials();
          const browser = yield* recordingBrowser;
          const stderr: Array<string> = [];
          const result = yield* runCli(
            ["--json", "login", "--base-url", server.baseUrl, "--no-browser"],
            undefined,
            {
              credentials: creds.layer,
              browser: browser.layer,
              stderr,
              pacing: {
                sleep: (duration) =>
                  Effect.gen(function* () {
                    const code = printedCode(stderr);
                    if (code !== undefined) yield* server.decide(code, "grace@example.com");
                    yield* TestClock.adjust(duration);
                  }),
              },
            },
          );
          assert.strictEqual(result.code, 0, everything(result));
          assert.deepStrictEqual(yield* Ref.get(browser.opened), []);
          // stdout is exactly one JSON document (the instructions went to stderr).
          const document = JSON.parse(result.stdout.join("\n"));
          assert.strictEqual(document.method, "device");
          assert.strictEqual(document.baseUrl, server.baseUrl);
          assert.isString(document.sessionId);
          assert.include(stderr.join("\n"), "Waiting for approval");
        }),
      ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "adds 5 seconds to its interval on every slow_down, and never polls faster than the server advises",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveAuth();
          const creds = yield* memoryCredentials();
          const stderr: Array<string> = [];
          const sleeps: Array<number> = [];
          const result = yield* runCli(["login", "--base-url", server.baseUrl], undefined, {
            credentials: creds.layer,
            stderr,
            pacing: {
              sleep: (duration) =>
                Effect.gen(function* () {
                  sleeps.push(Duration.toSeconds(duration));
                  // A client whose clock is too fast: time does not pass between the first waits, so the server
                  // answers slow_down. Once it has been told to slow down twice, real time catches up and the person approves.
                  if (sleeps.length >= 4) {
                    const code = printedCode(stderr);
                    if (code !== undefined && sleeps.length === 4) {
                      yield* server.decide(code, "slow@example.com");
                    }
                    yield* TestClock.adjust(Duration.minutes(1));
                  }
                }),
            },
          });
          assert.strictEqual(result.code, 0, everything(result));
          // The first wait is the advised 5 and its poll is pending. The second wait is 5 again, but no time passed,
          // so its poll is slow_down: +5 -> 10. The third (still too soon) is slow_down again: +5 -> 15. Each wait
          // after a slow_down is at least the previous plus 5 (RFC 8628 §3.5).
          assert.deepStrictEqual(sleeps, [5, 5, 10, 15]);
        }),
      ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("a denied request ends the login (exit 8) and stores nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveAuth();
        const creds = yield* memoryCredentials();
        const stderr: Array<string> = [];
        const result = yield* runCli(["login", "--base-url", server.baseUrl], undefined, {
          credentials: creds.layer,
          stderr,
          pacing: {
            sleep: (duration) =>
              Effect.gen(function* () {
                const code = printedCode(stderr);
                if (code !== undefined) yield* server.decide(code, "no@example.com", "deny");
                yield* TestClock.adjust(duration);
              }),
          },
        });
        assert.strictEqual(result.code, 8);
        assert.include(everything(result), "denied");
        assert.strictEqual(yield* Ref.get(creds.writes), 0);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("a code nobody approved expires (exit 8) and stores nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveAuth();
        const creds = yield* memoryCredentials();
        const result = yield* runCli(["login", "--base-url", server.baseUrl], undefined, {
          credentials: creds.layer,
          pacing: { sleep: () => TestClock.adjust(Duration.minutes(16)) },
        });
        assert.strictEqual(result.code, 8);
        assert.include(everything(result), "expired");
        assert.strictEqual(yield* Ref.get(creds.writes), 0);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("a server without the plugin is exit 9 and names it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveAuth({ device: false });
        const creds = yield* memoryCredentials();
        const result = yield* runCli(["login", "--base-url", server.baseUrl], undefined, {
          credentials: creds.layer,
          pacing: { sleep: () => Effect.void },
        });
        assert.strictEqual(result.code, 9);
        assert.include(everything(result), "DeviceAuthorization");
        assert.include(everything(result), "--token");
        assert.strictEqual(yield* Ref.get(creds.writes), 0);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("an unreachable server is exit 9, not a crash", () =>
    Effect.gen(function* () {
      const result = yield* runCli(["login", "--base-url", "http://127.0.0.1:1"], undefined, {
        pacing: { sleep: () => Effect.void },
      });
      assert.strictEqual(result.code, 9);
    }),
  );

  it.effect(
    "a client id the server does not know is a usage error (exit 2) that says how to fix it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveAuth();
          const result = yield* runCli(
            ["login", "--base-url", server.baseUrl, "--client-id", "not-registered"],
            undefined,
            { pacing: { sleep: () => Effect.void } },
          );
          assert.strictEqual(result.code, 2);
          assert.include(everything(result), "not-registered");
        }),
      ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("--token still wins: no device code is requested when a token is given", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveAuth();
        const { token } = yield* server.issue("token@example.com");
        const creds = yield* memoryCredentials();
        const stderr: Array<string> = [];
        const result = yield* runCli(
          ["login", "--token", token, "--base-url", server.baseUrl],
          undefined,
          { credentials: creds.layer, stderr },
        );
        assert.strictEqual(result.code, 0, everything(result));
        assert.notInclude(stderr.join("\n"), "confirm the code");
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});

describe("Browser (BEH-EA-307)", () => {
  it("opens only web URLs, one argv element per URL, with the platform's own opener", () => {
    assert.isTrue(Browser.isWebUrl("https://app.example.com/device?user_code=BCDF-GHJK"));
    assert.isTrue(Browser.isWebUrl("http://127.0.0.1:3000/device"));
    for (const refused of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ssh://host",
      "not a url",
      "",
    ]) {
      assert.isFalse(Browser.isWebUrl(refused), refused);
    }
    const url = "https://app.example.com/device?a=1&b=2";
    assert.deepStrictEqual(Browser.openerFor("darwin", url), { command: "open", args: [url] });
    assert.deepStrictEqual(Browser.openerFor("linux", url), { command: "xdg-open", args: [url] });
    assert.deepStrictEqual(Browser.openerFor("win32", url), {
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", url],
    });
    assert.isUndefined(Browser.openerFor("freebsd", url));
  });

  it.effect("answers false, never a failure, when there is no opener or the opener fails", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const browser = (platform: string, exitCode: number | undefined) =>
        Browser.make(platform, {
          run: (command, args) => {
            calls.push([command, ...args]);
            return Effect.succeed(exitCode === undefined ? undefined : { exitCode, stdout: "" });
          },
        });
      const url = "https://app.example.com/device";
      assert.isTrue(yield* browser("linux", 0).open(url));
      assert.isFalse(yield* browser("linux", 1).open(url));
      assert.isFalse(yield* browser("linux", undefined).open(url));
      assert.isFalse(yield* browser("freebsd", 0).open(url));
      // A refused scheme is never handed to an opener.
      const before = calls.length;
      assert.isFalse(yield* browser("linux", 0).open("file:///etc/passwd"));
      assert.strictEqual(calls.length, before);
    }),
  );
});
