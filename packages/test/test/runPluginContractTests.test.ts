// spec/behaviors/25-testing-harness.md, BEH-EA-198, BEH-EA-199 (both halves).
//
// Exercised with a recording `TestFramework` (not `@effect/vitest`'s real
// `describe`/`it`) so each check's pass/fail can be asserted on directly —
// a real, well-formed plugin (`@awthaq/password`'s own `Password`)
// proves every check passes cleanly; small deliberately-broken fixture
// plugins each prove one specific check actually catches its violation.
import { Password } from "@awthaq/password";
import { Auth, AuthPlugin } from "@awthaq/core";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as RedactionGuard from "../src/RedactionGuard.ts";
import * as TestAuth from "../src/TestAuth.ts";

class Recorder {
  readonly passed: Array<string> = [];
  readonly failed: Array<string> = [];
  readonly pending: Array<Promise<void>> = [];
  /** Resolves once every registered check (sync or async) has settled. */
  settled() {
    return Promise.all(this.pending).then(() => undefined);
  }
}

const recordingFramework = (sink: Recorder): TestAuth.TestFramework => ({
  describe: (_name, body) => body(),
  it: (name, body) => {
    sink.pending.push(
      Promise.resolve()
        .then(body)
        .then(
          () => {
            sink.passed.push(name);
          },
          (error: unknown) => {
            sink.failed.push(
              `${name} :: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        ),
    );
  },
  fail: (message) => {
    throw new Error(message);
  },
});

const fakePlugin = (overrides: Partial<AuthPlugin.Any>): AuthPlugin.Any => ({
  id: "fake",
  apiVersion: 1,
  contract: { identifier: "auth", groups: {} },
  tables: [],
  migrations: [],
  dependsOn: [],
  layer: Layer.empty,
  ...overrides,
});

describe("runPluginContractTests (BEH-EA-198/199)", () => {
  it("a real, well-formed plugin (Password) passes every check", async () => {
    const sink = new Recorder();
    TestAuth.runPluginContractTests(recordingFramework(sink), () => Password.Password, {
      options: [{}, {}],
    });
    await sink.settled();
    assert.deepStrictEqual(sink.failed, []);
    assert.isAbove(sink.passed.length, 0);
  });

  it("catches a table missing this plugin's own id prefix", async () => {
    const sink = new Recorder();
    TestAuth.runPluginContractTests(
      recordingFramework(sink),
      () => fakePlugin({ id: "invite", tables: ["invite_codes", "other_table"] }),
      { options: [{}] },
    );
    await sink.settled();
    assert.isTrue(sink.failed.some((message) => message.includes("other_table")));
  });

  it("catches a missing host dependency as E_PLUGIN_MISSING_DEP", async () => {
    const sink = new Recorder();
    const host = fakePlugin({ id: "password" });
    TestAuth.runPluginContractTests(
      recordingFramework(sink),
      () => fakePlugin({ id: "invite", dependsOn: [host] }),
      { options: [{}], host: [] },
    );
    await sink.settled();
    assert.isTrue(sink.failed.some((message) => message.includes("E_PLUGIN_MISSING_DEP")));
  });

  it("passes the missing-dependency check once the host plugin is actually present", async () => {
    const sink = new Recorder();
    const host = fakePlugin({ id: "password" });
    TestAuth.runPluginContractTests(
      recordingFramework(sink),
      () => fakePlugin({ id: "invite", dependsOn: [host] }),
      { options: [{}], host: [host] },
    );
    await sink.settled();
    assert.isFalse(sink.failed.some((message) => message.includes("E_PLUGIN_MISSING_DEP")));
  });

  it("catches an id colliding with a host plugin", async () => {
    const sink = new Recorder();
    const host = fakePlugin({ id: "password" });
    TestAuth.runPluginContractTests(
      recordingFramework(sink),
      () => fakePlugin({ id: "password" }),
      {
        options: [{}],
        host: [host],
      },
    );
    await sink.settled();
    assert.isTrue(sink.failed.some((message) => message.includes("E_PLUGIN_DUPLICATE_ID")));
  });

  it("catches a contract that changes with a different option value", async () => {
    const sink = new Recorder();
    TestAuth.runPluginContractTests(
      recordingFramework(sink),
      (_options: { readonly variant: string }) =>
        fakePlugin({ contract: { identifier: "auth", groups: {} } }),
      { options: [{ variant: "a" }, { variant: "b" }] },
    );
    await sink.settled();
    assert.isTrue(sink.failed.some((message) => message.includes("contract changed")));
  });
});

/** A composable fixture: `Auth.make` needs at least one contract group, which `fakePlugin`'s empty contract lacks. */
const composable = (id: string, overrides: Partial<AuthPlugin.Any>): AuthPlugin.Any =>
  fakePlugin({
    id,
    contract: { identifier: "auth", groups: { [id]: HttpApiGroup.make(id) } },
    ...overrides,
  });

describe("runPluginContractTests — migrations are actually applied twice (SSMS-004, REQ-EA-563)", () => {
  const createTable = (table: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
    });

  it("a plugin with well-formed migrations passes", async () => {
    const sink = new Recorder();
    TestAuth.runPluginContractTests(
      recordingFramework(sink),
      () =>
        composable("fx", {
          id: "fx",
          tables: ["fx_note"],
          migrations: [{ name: "create_note", up: createTable("fx_note") }],
        }),
      { options: [{}] },
    );
    await sink.settled();
    assert.deepStrictEqual(sink.failed, []);
    assert.isTrue(sink.passed.some((name) => name.includes("apply identically on two fresh")));
  });

  it("a nondeterministic `up` (its table name differs per build) is caught", async () => {
    const sink = new Recorder();
    let counter = 0;
    TestAuth.runPluginContractTests(
      recordingFramework(sink),
      () =>
        composable("nd", {
          id: "nd",
          tables: [],
          // Evaluated when the migration runs, so each application creates a differently-named table.
          migrations: [
            {
              name: "create_flaky",
              up: Effect.suspend(() => createTable(`nd_flaky_${(counter += 1)}`)),
            },
          ],
        }),
      { options: [{}] },
    );
    await sink.settled();
    assert.isTrue(
      sink.failed.some(
        (message) => message.includes("apply identically") && message.includes("different schemas"),
      ),
      sink.failed.join("\n"),
    );
  });

  it("a migration that fails to apply is reported, not swallowed", async () => {
    const sink = new Recorder();
    TestAuth.runPluginContractTests(
      recordingFramework(sink),
      () =>
        composable("bad", {
          id: "bad",
          migrations: [{ name: "broken", up: Effect.die(new Error("boom")) }],
        }),
      { options: [{}] },
    );
    await sink.settled();
    assert.isTrue(sink.failed.some((message) => message.includes("failed to apply")));
  });
});

// ---- PV-252 / INV-EA-016: a plugin migration may not alter a shared (core-owned) table ----

describe("runPluginContractTests — migration ownership (PV-252, INV-EA-016)", () => {
  const sqlExec = (statement: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(statement);
    });

  const run = async (
    migration: { readonly name: string; readonly up: ReturnType<typeof sqlExec> },
    id = "own",
  ) => {
    const sink = new Recorder();
    TestAuth.runPluginContractTests(
      recordingFramework(sink),
      () => composable(id, { id, migrations: [migration] }),
      { options: [{}] },
    );
    await sink.settled();
    return sink;
  };

  it("a migration that ALTERs a core table is rejected, naming the table", async () => {
    const sink = await run({
      name: "alter_users",
      up: sqlExec("ALTER TABLE users ADD COLUMN own_flag TEXT"),
    });
    assert.isTrue(
      sink.failed.some((message) => message.includes("INV-EA-016") && message.includes('"users"')),
      sink.failed.join("\n"),
    );
  });

  it("a migration that indexes a core table is rejected too", async () => {
    const sink = await run({
      name: "index_users",
      up: sqlExec("CREATE INDEX own_users_name ON users (name)"),
    });
    assert.isTrue(
      sink.failed.some((message) => message.includes("INV-EA-016") && message.includes("users")),
      sink.failed.join("\n"),
    );
  });

  it("a table created outside the plugin's own prefix is rejected", async () => {
    const sink = await run({
      name: "create_stray",
      up: sqlExec("CREATE TABLE stray_table (id TEXT PRIMARY KEY)"),
    });
    assert.isTrue(
      sink.failed.some(
        (message) => message.includes("INV-EA-016") && message.includes("stray_table"),
      ),
      sink.failed.join("\n"),
    );
  });

  it("a table under the plugin's own prefix passes the ownership check", async () => {
    const sink = await run({
      name: "create_own",
      up: sqlExec("CREATE TABLE own_note (id TEXT PRIMARY KEY)"),
    });
    assert.deepStrictEqual(sink.failed, []);
    assert.isTrue(sink.passed.some((name) => name.includes("INV-EA-016")));
  });
});

// ---- BEH-EA-199: the redaction half ---------------------------------------------

const NoBreachHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(`${"F".repeat(35)}:1`, { status: 200 })),
    ),
  ),
);

/** The support layers `Password` needs beyond `TestAuth`'s memory bundle (which already carries `Verification` and a hasher). */
const PasswordServices = Layer.mergeAll(
  Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
  Csrf.CsrfProtectionLive.pipe(
    Layer.provide(
      Layer.succeed(Csrf.CsrfConfig, {
        secret: Redacted.make("redaction-guard-test-csrf-secret-padded-to-32-bytes"),
        allowedOrigins: [],
      }),
    ),
  ),
  NoBreachHttpClient,
).pipe(Layer.provide(NodeCrypto.layer));

const passwordApp = TestAuth.layer(Auth.make([Password.Password]), PasswordServices);

describe("runPluginContractTests — the redaction check (EOTS-002, BEH-EA-199)", () => {
  const PASSWORD_CANARY = "canary-Passw0rd-correct-horse";

  it("@awthaq/password passes: its flows leak neither a Redacted nor the canary password", async () => {
    const sink = new Recorder();
    TestAuth.runPluginContractTests(recordingFramework(sink), () => Password.Password, {
      options: [{}],
      redaction: {
        app: passwordApp,
        exercise: (guard) =>
          Effect.gen(function* () {
            yield* guard.watch("password", PASSWORD_CANARY);
            const password = yield* Password.Password;
            yield* password.signUp({
              email: "canary@example.com",
              password: Redacted.make(PASSWORD_CANARY),
            });
            // A wrong password too: the failure path logs and publishes as well.
            yield* password
              .signIn({ email: "canary@example.com", password: Redacted.make("not-the-password") })
              .pipe(Effect.ignore);
          }),
      },
    });
    await sink.settled();
    assert.deepStrictEqual(sink.failed, []);
    assert.isTrue(sink.passed.some((name) => name.includes("no Redacted value or watched secret")));
  });

  it("fails a plugin that logs a Redacted value", async () => {
    const sink = new Recorder();
    TestAuth.runPluginContractTests(recordingFramework(sink), () => Password.Password, {
      options: [{}],
      redaction: {
        app: passwordApp,
        exercise: () => Effect.log("signing in", Redacted.make("s3cr3t-value")),
      },
    });
    await sink.settled();
    const failure = sink.failed.find((message) => message.includes("BEH-EA-199"));
    assert.isDefined(failure);
    assert.include(failure ?? "", "Redacted instance");
    assert.include(failure ?? "", "log message");
    assert.notInclude(failure ?? "", "s3cr3t-value");
  });

  it("fails a plugin that unwraps a secret into a span attribute, naming the canary's label", async () => {
    const sink = new Recorder();
    TestAuth.runPluginContractTests(recordingFramework(sink), () => Password.Password, {
      options: [{}],
      redaction: {
        app: passwordApp,
        exercise: (guard) =>
          Effect.gen(function* () {
            const secret = Redacted.make("plaintext-session-token");
            yield* guard.watch("session token", Redacted.value(secret));
            yield* Effect.annotateCurrentSpan("token", Redacted.value(secret)).pipe(
              Effect.withSpan("plugin.operation"),
            );
          }),
      },
    });
    await sink.settled();
    const failure = sink.failed.find((message) => message.includes("BEH-EA-199"));
    assert.isDefined(failure);
    assert.include(failure ?? "", 'canary "session token"');
    assert.include(failure ?? "", "span attribute");
    assert.notInclude(failure ?? "", "plaintext-session-token");
  });

  it("fails a plugin that publishes a watched secret in an event payload", async () => {
    const sink = new Recorder();
    TestAuth.runPluginContractTests(recordingFramework(sink), () => Password.Password, {
      options: [{}],
      redaction: {
        app: passwordApp,
        exercise: (guard) =>
          Effect.gen(function* () {
            yield* guard.watch("reset token", "reset-token-abcdef");
            yield* guard.inspectEvent("auth.token.replay", { identifier: "reset-token-abcdef" });
          }),
      },
    });
    await sink.settled();
    assert.isTrue(sink.failed.some((message) => message.includes('canary "reset token"')));
  });

  it("rejects a canary too short to match meaningfully", async () => {
    const sink = new Recorder();
    TestAuth.runPluginContractTests(recordingFramework(sink), () => Password.Password, {
      options: [{}],
      redaction: {
        app: passwordApp,
        exercise: (guard: RedactionGuard.RedactionGuardShape) => guard.watch("pin", "1234"),
      },
    });
    await sink.settled();
    assert.isTrue(sink.failed.some((message) => message.includes("shorter than")));
  });
});
