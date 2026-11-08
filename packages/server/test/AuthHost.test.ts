// BEH-EA-340/341, ADR-EA-044 (plan 15): `AuthHost.layer` derives the servable layer from `Auth.make`, and in SQL mode
// never serves a schema behind it. Driven over the `Ledger` fixture, in both persistence modes where the case is
// about the composition (SQL on SQLite here; the Postgres run of the same module is `@awthaq/test`'s
// `TestAuthHost.test.ts`, which reaches it through `TestAuth`). `@awthaq/server` sits below `@awthaq/test`, so the
// handle below is a minimal `TestAuth.app`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Api } from "@awthaq/api";
import { Auth, AuditLog, Errors, Migrations, Sessions, Users } from "@awthaq/core";
import { ClientAddress, RateLimiter } from "@awthaq/ports";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";
import * as AuthHost from "../src/AuthHost.ts";
import * as Credentials from "../src/Credentials.ts";
import * as HostPorts from "./support/HostPorts.ts";
import {
  AfterLedgerEntry,
  Ledger,
  LedgerConfig,
  LedgerRecords,
  recordModes,
} from "./support/LedgerPlugin.ts";
import * as Wiring from "./support/Wiring.ts";

const built = Auth.make([Ledger]);
const csrf = Wiring.csrfConfig();

/** The served layer and a context built through one memo map, so a session minted in `run` authenticates `request`. */
const serve = <A, E>(layer: Layer.Layer<A, E>) => {
  const memoMap = Layer.makeMemoMapUnsafe();
  const scope = Scope.makeUnsafe();
  const web = HttpRouter.toWebHandler(layer, { memoMap, disableLogger: true });
  let context: Promise<Context.Context<A>> | undefined;
  // In-process work answers no request (ADR-EA-047).
  const run = <X, XE>(effect: Effect.Effect<X, XE, A | Api.AuthRequestContext>) => {
    context ??= Effect.runPromise(Layer.buildWithMemoMap(layer, memoMap, scope));
    return context.then((services) =>
      Effect.runPromiseWith(services)(
        Effect.provideService(effect, Api.AuthRequestContext, Api.AuthRequestContext.noRequest),
      ),
    );
  };
  const request = (
    method: string,
    route: string,
    init: {
      readonly cookie?: string;
      readonly json?: unknown;
      readonly headers?: Record<string, string>;
    } = {},
  ) => {
    const token = Wiring.mintCsrfToken(Math.floor(Date.now() / 1000));
    return web.handler(
      new Request(`http://localhost${route}`, {
        method,
        headers: {
          cookie: [init.cookie, `${Api.CSRF_COOKIE_NAME}=${token}`]
            .filter((part) => part !== undefined)
            .join("; "),
          [Api.CSRF_HEADER_NAME]: token,
          ...(init.json === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      }),
    );
  };
  const dispose = async () => {
    await web.dispose();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  };
  return { run, request, dispose };
};

/** Mints a user and a session straight against `Users`/`Sessions`; the cookie header for a request. */
const signIn = (email: string) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const sessions = yield* Sessions.Sessions;
    const user = yield* users
      .create({ identity: { _tag: "Email", email }, name: email })
      .pipe(Effect.orDie);
    const { token } = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
    return {
      userId: user.id,
      cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}`,
    };
  });

const hosted = (records: "memory" | "sql") =>
  records === "memory"
    ? AuthHost.layer(built, { persistence: { records: "memory" }, csrf })
    : AuthHost.layer(built, {
        persistence: {
          records: "sql",
          client: SqliteClient.layer({ filename: ":memory:" }),
          migrations: "apply",
        },
        csrf,
      });

/** The host-owned remainder: the ports and the HTTP platform. */
const provided = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(Layer.provideMerge(HostPorts.Ports), Layer.provideMerge(HostPorts.Platform));

const failureTag = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? Option.match(Exit.findErrorOption(exit), {
        onNone: () => "defect",
        onSome: (error) =>
          typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "?",
      })
    : "success";

for (const records of recordModes) {
  describe(`AuthHost.layer (${records})`, () => {
    it("BEH-EA-340: serves the composition with no hand-built middleware, records, hook points or core services", async () => {
      const app = serve(provided(hosted(records)));
      try {
        const { cookie } = await app.run(signIn("ada@example.com"));
        const added = await app.request("POST", "/ledger", { cookie, json: { label: "first" } });
        assert.strictEqual(added.status, 200);
        const listed = await app.request("GET", "/ledger", { cookie });
        assert.deepStrictEqual(await listed.json(), ["first"]);
        assert.strictEqual((await app.request("GET", "/session")).status, 401);
      } finally {
        await app.dispose();
      }
    });

    it("BEH-EA-340: the plugin's records bundle for the mode is the one the plugin writes through", async () => {
      const app = serve(provided(hosted(records)));
      try {
        const { cookie } = await app.run(signIn("grace@example.com"));
        await app.request("POST", "/ledger", { cookie, json: { label: "kept" } });
        assert.deepStrictEqual(
          await app.run(Effect.flatMap(Effect.service(LedgerRecords), (store) => store.list)),
          ["kept"],
        );
        // The one client is in the output exactly in SQL mode, and the row is in the plugin's own table.
        const rows = await app.run(
          Effect.flatMap(Effect.serviceOption(SqlClient.SqlClient), (client) =>
            Option.match(client, {
              onNone: () => Effect.succeed(Option.none<ReadonlyArray<string>>()),
              onSome: (sql) =>
                sql<{ readonly label: string }>`SELECT label FROM ledger_entry`.pipe(
                  Effect.map((found) => Option.some(found.map((row) => row.label))),
                ),
            }),
          ),
        );
        assert.deepStrictEqual(rows, records === "sql" ? Option.some(["kept"]) : Option.none());
      } finally {
        await app.dispose();
      }
    });

    it("BEH-EA-340: a host tap receives the plugin's own hook point instance", async () => {
      const seen: Array<string> = [];
      const layer =
        records === "memory"
          ? AuthHost.layer(built, {
              persistence: { records: "memory" },
              csrf,
              taps: AfterLedgerEntry.tap((entry) => Effect.sync(() => seen.push(entry.label))),
            })
          : AuthHost.layer(built, {
              persistence: {
                records: "sql",
                client: SqliteClient.layer({ filename: ":memory:" }),
                migrations: "apply",
              },
              csrf,
              taps: AfterLedgerEntry.tap((entry) => Effect.sync(() => seen.push(entry.label))),
            });
      const app = serve(provided(layer));
      try {
        const { cookie } = await app.run(signIn("lin@example.com"));
        await app.request("POST", "/ledger", { cookie, json: { label: "tapped" } });
        assert.deepStrictEqual(seen, ["tapped"]);
      } finally {
        await app.dispose();
      }
    });

    it("BEH-EA-340: declared user fields are validated and served", async () => {
      const app = serve(provided(hosted(records)));
      try {
        const { cookie, userId } = await app.run(signIn("joan@example.com"));
        const patched = await app.request("PATCH", "/user", {
          cookie,
          json: { name: "Joan", fields: { ledger_tier: "gold" } },
        });
        assert.strictEqual(patched.status, 200);
        assert.deepStrictEqual(
          await app.run(
            Effect.flatMap(Effect.service(Users.Users), (users) => users.getFields(userId)),
          ),
          { ledger_tier: "gold" },
        );
        const unknown = await app.request("PATCH", "/user", {
          cookie,
          json: { name: "Joan", fields: { ledger_unknown: "x" } },
        });
        assert.strictEqual(unknown.status, 422);
      } finally {
        await app.dispose();
      }
    });

    it("AR-003: tier selects the served groups; the plugin layer is always built whole", async () => {
      const tiered = (tier: "public" | "admin") =>
        records === "memory"
          ? AuthHost.layer(built, { persistence: { records: "memory" }, csrf, tier })
          : AuthHost.layer(built, {
              persistence: {
                records: "sql",
                client: SqliteClient.layer({ filename: ":memory:" }),
                migrations: "apply",
              },
              csrf,
              tier,
            });
      const publicApp = serve(provided(tiered("public")));
      try {
        const { cookie } = await publicApp.run(signIn("pub@example.com"));
        assert.strictEqual(
          (await publicApp.request("GET", "/ledger/admin/count", { cookie })).status,
          404,
        );
        assert.strictEqual((await publicApp.request("GET", "/ledger", { cookie })).status, 200);
        assert.strictEqual((await publicApp.request("GET", "/session")).status, 401);
      } finally {
        await publicApp.dispose();
      }
      const adminApp = serve(provided(tiered("admin")));
      try {
        const { cookie } = await adminApp.run(signIn("adm@example.com"));
        const count = await adminApp.request("GET", "/ledger/admin/count", { cookie });
        assert.strictEqual(count.status, 200);
        assert.strictEqual(await count.json(), 0);
        assert.strictEqual((await adminApp.request("GET", "/session", { cookie })).status, 404);
      } finally {
        await adminApp.dispose();
      }
    });
  });
}

describe("AuthHost.layer requirements", () => {
  it("BEH-EA-340: the host-owned set the compiler reports is all the layer needs at runtime", async () => {
    // Exactly `RIn` for core plus `Ledger` (pinned in AuthHost.types.test.ts): no mailer, hasher or key; the client
    // address topology is the request context's (ADR-EA-047).
    const app = serve(
      AuthHost.layer(built, { persistence: { records: "memory" }, csrf }).pipe(
        Layer.provideMerge(RateLimiter.layerPermissive),
        Layer.provideMerge(ClientAddress.layerDirect),
        Layer.provideMerge(HostPorts.Crypto),
        Layer.provideMerge(HostPorts.Platform),
      ),
    );
    try {
      const { cookie } = await app.run(signIn("min@example.com"));
      assert.strictEqual(
        (await app.request("POST", "/ledger", { cookie, json: { label: "x" } })).status,
        200,
      );
    } finally {
      await app.dispose();
    }
  });
});

describe("AuthHost.layer migrations (sql)", () => {
  const withFile = async (body: (filename: string) => Promise<void>) => {
    const dir = mkdtempSync(path.join(tmpdir(), "awthaq-auth-host-"));
    try {
      await body(path.join(dir, "auth.sqlite"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const onFile = (filename: string, migrations: Migrations.OnBuild) =>
    provided(
      AuthHost.layer(built, {
        persistence: { records: "sql", client: SqliteClient.layer({ filename }), migrations },
        csrf,
      }),
    );
  /** Reads the database directly, beside the app, to see what a build did to it. */
  const inspect = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(Api.AuthRequestContext, Api.AuthRequestContext.noRequest),
        Effect.provide(SqliteClient.layer({ filename })),
      ),
    );
  const ledgerRows = (table: string) =>
    Effect.gen(function* () {
      if (!(yield* Migrations.tableExists(table))) return -1;
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`SELECT migration_id FROM ${sql(table)}`;
      return rows.length;
    });

  it("BEH-EA-341: apply migrates an empty database before any service is built, and a second build applies nothing", async () => {
    await withFile(async (filename) => {
      const first = serve(onFile(filename, "apply"));
      try {
        const { cookie } = await first.run(signIn("boot@example.com"));
        assert.strictEqual(
          (await first.request("POST", "/ledger", { cookie, json: { label: "persisted" } })).status,
          200,
        );
      } finally {
        await first.dispose();
      }
      const applied = await inspect(filename, ledgerRows(Migrations.pluginMigrationsTable));
      // Ledger's table, then the `tier` user-field column the linker generates.
      assert.strictEqual(applied, built.migrations.length);
      const second = serve(onFile(filename, "apply"));
      try {
        assert.deepStrictEqual(
          await second.run(Effect.flatMap(Effect.service(LedgerRecords), (store) => store.list)),
          ["persisted"],
        );
      } finally {
        await second.dispose();
      }
      assert.strictEqual(
        await inspect(filename, ledgerRows(Migrations.pluginMigrationsTable)),
        applied,
      );
      // `verify` accepts what `apply` produced.
      const verified = serve(onFile(filename, "verify"));
      try {
        await verified.run(Effect.void);
      } finally {
        await verified.dispose();
      }
    });
  });

  it("BEH-EA-341: verify refuses an unmigrated database with Migrations/Pending and builds nothing over the client", async () => {
    await withFile(async (filename) => {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(Layer.build(onFile(filename, "verify"))),
      );
      assert.strictEqual(failureTag(exit), "Migrations/Pending");
      const message = Option.match(
        Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none(),
        {
          onNone: () => "",
          onSome: (error) => (error instanceof Migrations.Pending ? error.message : ""),
        },
      );
      assert.include(message, "plugins 0001_ledger_create_ledger_entry");
      assert.strictEqual(await inspect(filename, ledgerRows(Migrations.coreMigrationsTable)), -1);
      assert.isFalse(await inspect(filename, Migrations.tableExists("users")));
    });
  });

  it("BEH-EA-341: apply refuses a drifted ledger and the layer fails to build", async () => {
    await withFile(async (filename) => {
      await inspect(filename, Migrations.apply(built.migrations));
      await inspect(
        filename,
        Effect.flatMap(
          Effect.service(SqlClient.SqlClient),
          (sql) => sql`DELETE FROM awthaq_plugin_migrations WHERE migration_id = 1`,
        ),
      );
      const exit = await Effect.runPromiseExit(
        Effect.scoped(Layer.build(onFile(filename, "apply"))),
      );
      assert.strictEqual(failureTag(exit), "Migrations/LedgerDrift");
    });
  });
});

describe("AuthHost.layer dials", () => {
  it("ADR-EA-047: the request context is always derived, so every event a request causes carries its facts", async () => {
    const app = serve(
      provided(AuthHost.layer(built, { persistence: { records: "memory" }, csrf })),
    );
    try {
      const { cookie } = await app.run(signIn("rc@example.com"));
      const out = await app.request("POST", "/session/sign-out", {
        cookie,
        headers: { "x-request-id": "req-4242", "user-agent": "probe/1" },
      });
      assert.strictEqual(out.status, 204);
      const rows = await app.run(
        Effect.flatMap(Effect.service(AuditLog.AuditLog), (log) => log.list()),
      );
      const stamped = rows.find((row) => row.eventTag === "auth.session.revoked");
      assert.deepStrictEqual(stamped?.correlationId, Option.some("req-4242"));
      assert.deepStrictEqual(stamped?.userAgent, Option.some("probe/1"));
    } finally {
      await app.dispose();
    }
  });

  it("bodyLimit (default) refuses a body over the limit with 413; bodyLimit: false lets it through", async () => {
    const big = JSON.stringify({ label: "x".repeat(300 * 1024) });
    const post = async (bodyLimit: boolean) => {
      const app = serve(
        provided(AuthHost.layer(built, { persistence: { records: "memory" }, csrf, bodyLimit })),
      );
      try {
        const { cookie } = await app.run(signIn("big@example.com"));
        const token = Wiring.mintCsrfToken(Math.floor(Date.now() / 1000));
        return (
          await app.request("POST", "/ledger", {
            cookie,
            headers: {
              "content-type": "application/json",
              "content-length": String(big.length),
              cookie: `${cookie}; ${Api.CSRF_COOKIE_NAME}=${token}`,
              [Api.CSRF_HEADER_NAME]: token,
            },
            json: JSON.parse(big),
          })
        ).status;
      } finally {
        await app.dispose();
      }
    };
    assert.strictEqual(await post(true), 413);
    assert.strictEqual(await post(false), 200);
  });

  it("services: a host layer that provides a plugin's config is the one the plugin reads, and is in the output", async () => {
    const app = serve(
      provided(
        AuthHost.layer(built, {
          persistence: { records: "memory" },
          csrf,
          services: Layer.succeed(LedgerConfig, { prefix: "host:" }),
        }),
      ),
    );
    try {
      const { cookie } = await app.run(signIn("cfg@example.com"));
      const added = await app.request("POST", "/ledger", { cookie, json: { label: "x" } });
      assert.strictEqual(await added.json(), "host:x");
      assert.strictEqual((await app.run(Effect.service(LedgerConfig))).prefix, "host:");
    } finally {
      await app.dispose();
    }
  });

  it("decorate: a Sessions whose verify fails makes an authenticated request answer 503, and the output holds it", async () => {
    const Outage = Layer.effect(
      Sessions.Sessions,
      Effect.map(Effect.service(Sessions.Sessions), (sessions) => ({
        ...sessions,
        verify: () => Effect.fail(new Errors.StoreUnavailable({ operation: "test.verify" })),
      })),
    );
    const app = serve(
      provided(
        AuthHost.layer(built, { persistence: { records: "memory" }, csrf, decorate: Outage }),
      ),
    );
    try {
      const { cookie } = await app.run(signIn("down@example.com"));
      const added = await app.request("POST", "/ledger", { cookie, json: { label: "x" } });
      assert.strictEqual(added.status, 503);
      const verified = await app.run(
        Effect.flatMap(Effect.service(Sessions.Sessions), (sessions) =>
          Effect.exit(sessions.verify(Redacted.make("anything"))),
        ),
      );
      assert.isTrue(
        Exit.isFailure(verified) &&
          Cause.hasFails(verified.cause) &&
          failureTag(verified) === "StoreUnavailable",
      );
    } finally {
      await app.dispose();
    }
  });

  it("principalResolver: PrincipalResolverWithUserFactsLive puts emailVerified on the principal", async () => {
    const app = serve(
      provided(
        AuthHost.layer(built, {
          persistence: { records: "memory" },
          csrf,
          principalResolver: Credentials.PrincipalResolverWithUserFactsLive,
        }),
      ),
    );
    try {
      const principal = await app.run(
        Effect.gen(function* () {
          const { cookie } = yield* signIn("facts@example.com");
          const sessions = yield* Sessions.Sessions;
          const token = cookie.slice(`${Sessions.SESSION_COOKIE_NAME}=`.length);
          const { session } = yield* sessions.verify(Redacted.make(token)).pipe(Effect.orDie);
          const resolver = yield* Credentials.PrincipalResolver;
          return yield* resolver.resolve(session).pipe(Effect.orDie);
        }),
      );
      assert.isTrue(principal instanceof Api.UserPrincipal);
      assert.strictEqual(
        principal instanceof Api.UserPrincipal ? principal.emailVerified : undefined,
        false,
      );
    } finally {
      await app.dispose();
    }
  });
});
