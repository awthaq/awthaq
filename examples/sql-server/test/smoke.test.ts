// SEA-007: the example composition, booted in-process over a real SQLite database and driven over
// its HTTP surface. It proves what the memory example cannot: the migrations run (core's and the
// plugins', so a table-owning plugin serves), the users and sessions land in real tables, a *file*
// database survives a restart (a second boot on the same file applies nothing and signs the same
// user in), and with `AWTHAQ_MIGRATE_ON_BOOT=false` an unmigrated database refuses to boot.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { TestAuth } from "@awthaq/test";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import { Migrations } from "@awthaq/core";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { makeAppLayer } from "../app.ts";

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

// The double-submit pair CSRF protection requires on a mutation.
const csrfToken = TestAuth.csrfToken(CSRF_SECRET);

const boot = (env: Record<string, string>) => {
  // Every message the console mailer prints, read back the way a person reads it from the terminal.
  const printedMail: Array<Record<string, unknown>> = [];
  const CaptureMail = Logger.layer([
    Logger.make<unknown, void>((options) => {
      const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
      if (annotations["template"] !== undefined) printedMail.push({ ...annotations });
    }),
  ]);
  // The production composition, configured from `env` instead of the process environment, served in-process.
  const layer = makeAppLayer(NoBreachHttpClient).pipe(
    Layer.provideMerge(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { AWTHAQ_CSRF_SECRET: CSRF_SECRET, ...env } }),
      ),
    ),
    Layer.provideMerge(CaptureMail),
  );
  const app = TestAuth.app(layer, { baseUrl: ORIGIN });
  const call = (method: string, requestPath: string, body?: unknown, session?: string) =>
    app.handler(
      new Request(`${ORIGIN}${requestPath}`, {
        method,
        headers: {
          "content-type": "application/json",
          cookie: [session, `${CSRF_COOKIE}=${csrfToken}`]
            .filter((part) => part !== undefined)
            .join("; "),
          [CSRF_HEADER]: csrfToken,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { ...app, call, printedMail };
};

/** How many plugin migrations the file's ledger records (read beside the app, through its own client). */
const ledgerSize = (filename: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const status = yield* Migrations.status([]);
      return status.ledgers.reduce((total, ledger) => total + ledger.applied.length, 0);
    }).pipe(Effect.provide(SqliteClient.layer({ filename }))),
  );

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

  // Plan 15: Organization owns tables. Before `AuthHost` this composition ran only core's migrations and the request
  // answered 503 StoreUnavailable ("no such table: organization_membership").
  it("a plugin that owns tables is served over SQL: a signed-in user creates an organization", async () => {
    const app = boot({ SQLITE_FILE: ":memory:" });
    try {
      const email = "lin@example.com";
      const credentials = { email, password: PASSWORD };
      assert.strictEqual((await app.call("POST", "/password/sign-up", credentials)).status, 200);
      const mail = app.printedMail.find(
        (line) => line["to"] === email && line["template"] === "verify-email",
      );
      assert.strictEqual(
        (await app.call("POST", "/verify-email", { token: mail?.["token"] })).status,
        204,
      );
      const signedIn = await app.call("POST", "/password/sign-in", credentials);
      assert.strictEqual(signedIn.status, 200);
      const session = signedIn.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0] ?? "")
        .find((cookie) => cookie.startsWith("__Host-session="));
      assert.isString(session);
      const created = await app.call(
        "POST",
        "/organization",
        { name: "Acme", slug: "acme" },
        session,
      );
      assert.strictEqual(created.status, 200);
      const body: unknown = await created.json();
      assert.deepInclude(body, { slug: "acme" });
    } finally {
      await app.dispose();
    }
  });

  it("a SQLite file survives a restart: a second boot on the same file applies nothing and signs the same user in", async () => {
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
      const applied = await ledgerSize(env.SQLITE_FILE);
      const second = boot(env);
      try {
        assert.strictEqual(
          (await second.call("POST", "/password/sign-in", credentials)).status,
          200,
        );
      } finally {
        await second.dispose();
      }
      assert.strictEqual(await ledgerSize(env.SQLITE_FILE), applied);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with AWTHAQ_MIGRATE_ON_BOOT=false a fresh database refuses to boot and names the pending migrations", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "awthaq-sql-example-"));
    try {
      const app = boot({
        SQLITE_FILE: path.join(dir, "fresh.sqlite"),
        AWTHAQ_MIGRATE_ON_BOOT: "false",
      });
      try {
        const exit = await app.runtime.runPromiseExit(Effect.void);
        const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : undefined;
        assert.isTrue(error?._tag === "Some" && error.value instanceof Migrations.Pending);
        assert.include(
          error?._tag === "Some" && error.value instanceof Migrations.Pending
            ? error.value.message
            : "",
          "plugins 0001_organization_create_organization_org",
        );
      } finally {
        await app.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
