// SEA-007: the example composition, booted in-process over a real SQLite database and driven over
// its HTTP surface. It proves what the memory example cannot: the migrations run, the users and
// sessions land in real tables, and a *file* database survives a restart (a second `buildApp` on
// the same file signs the same user in).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { buildApp } from "../app.ts";

const ORIGIN = "http://localhost:3002";
const PASSWORD = "Zx9-quartz-Lantern-7431-orbit";
const CSRF_SECRET = randomBytes(32).toString("base64");
const CSRF_COOKIE = "__Host-csrf";
const CSRF_HEADER = "x-csrf-token";

// The breach-check transport, stubbed: an empty range response means "not breached", so the suite
// never touches the network.
const NoBreachHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

// `<iat>.<random>.<hmac(iat.random)>`: the double-submit pair CSRF protection requires on a mutation.
const csrfToken = (() => {
  const signed = `${Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  return `${signed}.${createHmac("sha256", CSRF_SECRET).update(signed).digest("hex")}`;
})();

const boot = (env: Record<string, string>) => {
  // Every message the console mailer prints, read back the way a person reads it from the terminal.
  const printedMail: Array<Record<string, unknown>> = [];
  const CaptureMail = Logger.layer([
    Logger.make<unknown, void>((options) => {
      const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
      if (annotations["template"] !== undefined) printedMail.push({ ...annotations });
    }),
  ]);
  const app = buildApp(
    { AWTHAQ_CSRF_SECRET: CSRF_SECRET, ...env },
    NoBreachHttpClient,
    CaptureMail,
  );
  const call = (method: string, requestPath: string, body?: unknown) =>
    app.handler(
      new Request(`${ORIGIN}${requestPath}`, {
        method,
        headers: {
          "content-type": "application/json",
          cookie: `${CSRF_COOKIE}=${csrfToken}`,
          [CSRF_HEADER]: csrfToken,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { ...app, call, printedMail };
};

describe("examples/sql-server (SEA-007)", () => {
  it("sign-up, the mailed token, verification and sign-in all work over SQLite", async () => {
    const app = boot({ SQLITE_FILE: ":memory:" });
    try {
      const email = "ada@example.com";
      const credentials = { email, password: PASSWORD };
      assert.strictEqual((await app.call("POST", "/password/sign-up", credentials)).status, 200);
      // Sign-in blocks until the mailed token is consumed.
      assert.strictEqual((await app.call("POST", "/password/sign-in", credentials)).status, 403);
      const mail = app.printedMail.find(
        (line) => line["to"] === email && line["template"] === "verify-email",
      );
      assert.isString(mail?.["token"]);
      assert.strictEqual(
        (await app.call("POST", "/verify-email", { token: mail?.["token"] })).status,
        204,
      );
      const signedIn = await app.call("POST", "/password/sign-in", credentials);
      assert.strictEqual(signedIn.status, 200);
      assert.isTrue(
        signedIn.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-session=")),
      );
    } finally {
      await app.dispose();
    }
  });

  it("a SQLite file survives a restart: a second boot on the same file signs the same user in", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "awthaq-sql-example-"));
    const env = { SQLITE_FILE: path.join(dir, "auth.sqlite") };
    const email = "grace@example.com";
    const credentials = { email, password: PASSWORD };
    try {
      const first = boot(env);
      try {
        assert.strictEqual(
          (await first.call("POST", "/password/sign-up", credentials)).status,
          200,
        );
        const mail = first.printedMail.find((line) => line["to"] === email);
        assert.isString(mail?.["token"]);
        assert.strictEqual(
          (await first.call("POST", "/verify-email", { token: mail?.["token"] })).status,
          204,
        );
      } finally {
        await first.dispose();
      }
      const second = boot(env);
      try {
        assert.strictEqual(
          (await second.call("POST", "/password/sign-in", credentials)).status,
          200,
        );
      } finally {
        await second.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
