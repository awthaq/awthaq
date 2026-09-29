// BEH-EA-201..208, 225..229 (26-cli.feature). See CliWorld.ts for the seam.
import { Api, EmailContract } from "@awthaq/api";
import { SessionCookie, AuditLog } from "@awthaq/core";
import { Mailer, RateLimiter } from "@awthaq/ports";
import { Passkey } from "@awthaq/passkey";
import { Organization } from "@awthaq/organization";
import { OAuth } from "@awthaq/oauth";
import { Password } from "@awthaq/password";
import { Auth } from "@awthaq/core";
import { Roles } from "@awthaq/roles";
import { BodyLimit } from "@awthaq/server";
import { defineSteps } from "@effect-cucumber/vitest";
import { role } from "@qadi/core";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as Net from "node:net";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import {
  argvOf,
  combined,
  EXIT,
  lastRun,
  migrate,
  passwordAndRoles,
  runCommand,
  sqlAppWithoutRoles,
  updateConfig,
  widgetOnly,
  WidgetConfig,
  World,
} from "./CliWorld.ts";
import { isNumber, isString, isStringArray } from "./shared/Outcomes.ts";

const editor = role({ name: "editor", permissions: [] });
/** A configuration Layer that leaves nothing for doctor to complain about. */
const goodConfig = Roles.config([editor]);

const secretConfig = Layer.succeed(WidgetConfig, {
  minLength: 12,
  clientSecret: "sk-canary-123",
  signingKey: Redacted.make("canary-signing-key"),
  databaseUrl: "postgres://app:hunter2-canary@db.internal/app",
});

const CANARIES = ["sk-canary-123", "hunter2-canary", "canary-signing-key"];

const here = Path.dirname(fileURLToPath(import.meta.url));
const packagesDir = Path.join(here, "../../packages");

/**
 * `awthaq <args>` from a step's command text. `seed admin` needs an account to seed and several
 * scenarios name only the command, so one is supplied when the text carries none.
 */
const runsFor = (command: string) =>
  Effect.gen(function* () {
    const argv = argvOf(command);
    const needsEmail = argv[0] === "seed" && argv[1] === "admin" && !argv.includes("--email");
    return yield* runCommand(needsEmail ? [...argv, "--email", "second@acme.com"] : argv);
  });

const countRows = (table: string) =>
  Effect.gen(function* () {
    const { sql } = yield* World;
    const rows = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM ${sql(table)}`;
    return Number(rows[0]?.n ?? 0);
  });

const tableNames = Effect.gen(function* () {
  const { sql } = yield* World;
  const rows = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
  return rows.map((row) => row.name);
});

/** Applies every migration to the World's database, so a later command finds a migrated one. */
const migrated = Effect.gen(function* () {
  const { sql } = yield* World;
  yield* migrate.pipe(Effect.provideService(SqlClient.SqlClient, sql));
});

const applyEverything = runsFor("awthaq migration apply --yes");

const auditTags = Effect.gen(function* () {
  const { app } = yield* World;
  const records = yield* AuditLog.AuditLog.use((log) => log.list()).pipe(Effect.provide(app));
  return records.map((record) => String(record.eventTag));
});

/** Watches for any TCP listener being started while a command runs (BEH-EA-208: the CLI never serves). */
const watchListeners = () => {
  const original = Net.Server.prototype.listen;
  let started = 0;
  Object.defineProperty(Net.Server.prototype, "listen", {
    configurable: true,
    writable: true,
    value: function (this: Net.Server, ...args: ReadonlyArray<never>) {
      started += 1;
      return Reflect.apply(original, this, args);
    },
  });
  return {
    started: () => started,
    stop: () => {
      Object.defineProperty(Net.Server.prototype, "listen", {
        configurable: true,
        writable: true,
        value: original,
      });
    },
  };
};

const emailAccepted = Schema.is(EmailContract.Email);

const exitCodeOf = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    return (yield* runCommand(argv)).code;
  });

export const cliSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- generic: run a command, then read what it did ----------------------------------------

  When("{string} runs", function* (command: string) {
    const { outcomes } = yield* World;
    const watch = watchListeners();
    try {
      yield* outcomes.set("ran", yield* runsFor(command));
    } finally {
      // Whatever ran, did it ever start a TCP listener? (BEH-EA-208: no command serves.)
      yield* outcomes.set("listeners", watch.started());
      watch.stop();
    }
  });

  // ---- BEH-EA-201: doctor -------------------------------------------------------------------

  Given("an installed plugin set with a missing declared dependency", function* () {
    const manifest = {
      plugins: [
        { id: "billing", apiVersion: 1 as const, tables: [], dependsOn: ["ledger"], groups: [] },
      ],
      hooks: {},
      config: [],
      userFields: [],
    };
    yield* updateConfig({ auth: { ...passwordAndRoles, manifest }, config: goodConfig });
  });

  Then("it reports the plugin-graph linking problem", function* () {
    const result = yield* lastRun;
    assert.equal(result.code, EXIT.doctorFindings);
    assert.match(combined(result), /missing-dependency/);
    assert.match(combined(result), /billing/);
  });

  Given(
    "an application whose configuration module provides a value for a declared configuration descriptor",
    function* () {
      yield* updateConfig({
        auth: widgetOnly,
        // A value the descriptor's audit does not like: below the minimum length.
        config: Layer.succeed(WidgetConfig, {
          minLength: 4,
          clientSecret: "sk-x",
          signingKey: Redacted.make("k"),
          databaseUrl: "postgres://app@db/app",
        }),
      });
    },
  );

  Then(
    "it reports the result of auditing that configuration value through its descriptor",
    function* () {
      assert.match(combined(yield* lastRun), /widget-short/);
    },
  );

  Given(
    "an application configured with {string} relaxed to {string}",
    function* (_knob: string, _value: string) {
      yield* updateConfig({
        auth: passwordAndRoles,
        production: true,
        config: Layer.mergeAll(
          goodConfig,
          SessionCookie.config({
            mode: SessionCookie.SecureDomain({ domain: "acme.com", sameSite: "lax" }),
          }),
        ),
      });
    },
  );

  Then(
    "it reports {string} relaxed to {string} as an insecure default",
    function* (_knob: string, _value: string) {
      assert.match(combined(yield* lastRun), /cookie-samesite-relaxed/);
    },
  );

  Given("an application configured with a mutating endpoint without CSRF protection", function* () {
    yield* updateConfig({ auth: widgetOnly, production: true, config: undefined });
  });

  Then(
    "it reports a mutating endpoint without CSRF protection as an insecure default",
    function* () {
      assert.match(combined(yield* lastRun), /csrf-missing/);
    },
  );

  Given("an application configured with an oversized request body limit", function* () {
    yield* updateConfig({
      auth: passwordAndRoles,
      production: true,
      config: Layer.mergeAll(goodConfig, BodyLimit.config({ maxBytes: ByteSize.mebibytes(64) })),
    });
  });

  Then("it reports an oversized request body limit as an insecure default", function* () {
    assert.match(combined(yield* lastRun), /body-limit-large/);
  });

  Given(
    "an application configured with a development mailer configured in a production environment",
    function* () {
      yield* updateConfig({
        auth: passwordAndRoles,
        production: true,
        config: goodConfig,
        app: Layer.mergeAll(goodConfig, Mailer.layerMemory, RateLimiter.layerMemory),
      });
    },
  );

  Then(
    "it reports a development mailer configured in a production environment as an insecure default",
    function* () {
      assert.match(combined(yield* lastRun), /mailer-development/);
    },
  );

  Given(
    "an application configured with a permissive rate limiter configured in a production environment",
    function* () {
      yield* updateConfig({
        auth: passwordAndRoles,
        production: true,
        config: goodConfig,
        app: Layer.mergeAll(goodConfig, Mailer.layerNoop, RateLimiter.layerPermissive),
      });
    },
  );

  Then(
    "it reports a permissive rate limiter configured in a production environment as an insecure default",
    function* () {
      assert.match(combined(yield* lastRun), /rate-limiter-permissive/);
    },
  );

  Given(
    "an application that is not started, with no live process and no listening server",
    function* () {
      const { outcomes } = yield* World;
      // Nothing to start: the composition is a module value, and no `app` Layer is even configured.
      yield* updateConfig({ auth: passwordAndRoles, config: goodConfig, app: undefined });
      yield* outcomes.set("listeners", 0);
    },
  );

  Then("it produces its full report", function* () {
    const result = yield* lastRun;
    assert.equal(result.code, 0);
    assert.ok(result.stdout.some((line) => line.includes("no findings")));
  });

  Then("no running application instance is required", function* () {
    const { config } = yield* World;
    assert.equal((yield* Ref.get(config)).app, undefined);
  });

  Given(
    "an OAuth client secret {string} and a database URL containing a password",
    function* (secret: string) {
      assert.equal(secret, "sk-canary-123");
      yield* updateConfig({ auth: widgetOnly, production: true, config: secretConfig });
    },
  );

  When("{string} runs with human and JSON output", function* (command: string) {
    const { outcomes } = yield* World;
    const human = yield* runsFor(command);
    const json = yield* runsFor(`${command} --json`);
    yield* outcomes.set("human", combined(human));
    yield* outcomes.set("json", combined(json));
    const listed = yield* runsFor("awthaq config list");
    yield* outcomes.set("configList", combined(listed));
  });

  Then("the output contains neither the secret nor the password", function* () {
    const { outcomes } = yield* World;
    for (const key of ["human", "json", "configList"]) {
      const text = yield* outcomes.getAs(key, isString);
      for (const canary of CANARIES)
        assert.equal(text.includes(canary), false, `${key} leaked ${canary}`);
    }
  });

  Then("the client secret is reported as present and valid", function* () {
    const { outcomes } = yield* World;
    // Present: `config list` shows the key, its value withheld. Valid: doctor's audit found nothing wrong with it.
    const list = yield* outcomes.getAs("configList", isString);
    assert.match(list, /clientSecret = <redacted>/);
    const human = yield* outcomes.getAs("human", isString);
    assert.doesNotMatch(human, /widget-short/);
  });

  Given(
    "an application Layer that fails to build because a required port is not provided",
    function* () {
      yield* updateConfig({
        auth: passwordAndRoles,
        config: goodConfig,
        app: Layer.effectDiscard(Effect.fail("a required port is not provided: sk-canary-123")),
      });
    },
  );

  Then("it reports the failure as a finding without serving the application", function* () {
    const result = yield* lastRun;
    assert.equal(result.code, EXIT.doctorFindings);
    assert.match(combined(result), /app-build-failed/);
    // The failure is reported as a finding — never quoted (it could carry a secret).
    assert.equal(combined(result).includes("sk-canary-123"), false);
  });

  // ---- BEH-EA-202: plugin list --graph ------------------------------------------------------

  const withOAuth = Auth.make([Password.Password, OAuth.OAuth]);

  Given(
    "an installed plugin set including {string} and {string}, where {string} depends on {string}",
    function* (_first: string, _second: string, _dependent: string, _dependency: string) {
      yield* updateConfig({ auth: withOAuth });
    },
  );

  Then("{string} is printed before {string}", function* (first: string, second: string) {
    const text = combined(yield* lastRun);
    const at = (id: string) => text.search(new RegExp(`(^|\\s)${id}(\\s|$)`, "m"));
    assert.ok(at(first) >= 0 && at(second) >= 0, text);
    assert.ok(at(first) < at(second));
  });

  Given(
    "an installed plugin set including {string}, which requires the {string} port",
    function* (_plugin: string, _port: string) {
      yield* updateConfig({ auth: withOAuth });
    },
  );

  Then(
    "it states that required ports are not printed rather than omitting them silently",
    function* () {
      assert.match(combined(yield* lastRun), /required ports .*not derivable/);
    },
  );

  Given(
    "an installed plugin set with taps registered on the {string} hook point",
    function* (_point: string) {
      yield* updateConfig({ auth: passwordAndRoles });
    },
  );

  Then(
    "it states that hook-tap chains are not printed rather than omitting them silently",
    function* () {
      assert.match(combined(yield* lastRun), /hook-tap chains are not derivable/);
    },
  );

  Given("an installed plugin set composed by {string}", function* (_make: string) {
    yield* updateConfig({ auth: withOAuth });
  });

  When("{string} prints the plugin order", function* (command: string) {
    const { outcomes } = yield* World;
    const json = yield* runsFor(`${command} --format json`);
    const parsed: unknown = JSON.parse(json.stdout.join("\n"));
    const ids = Array.isArray(parsed) ? parsed.map((node) => String(Reflect.get(node, "id"))) : [];
    yield* outcomes.set("printedOrder", ids);
  });

  Then(
    "that printed order is identical to the order the linker uses to sequence migrations and resolve hook taps",
    function* () {
      const { outcomes } = yield* World;
      const printed = yield* outcomes.getAs("printedOrder", isStringArray);
      // The linker's own order is the manifest's plugin order (Auth.make's topological sort).
      assert.deepEqual(
        printed,
        withOAuth.manifest.plugins.map((plugin) => plugin.id),
      );
    },
  );

  // ---- BEH-EA-203: routes -------------------------------------------------------------------

  Given(
    "a composed {string} contract with an endpoint {string} owned by group {string} and plugin {string}, protected by {string} middleware",
    function* (_api: string, endpoint: string, group: string, plugin: string, _middleware: string) {
      const { outcomes } = yield* World;
      assert.equal(endpoint, "POST /password/sign-in");
      assert.equal(group, "password");
      assert.equal(plugin, "Password");
      yield* updateConfig({ auth: passwordAndRoles });
      yield* outcomes.set("expectedRow", "POST");
    },
  );

  Then(
    "the listing includes a row for {string} carrying its method, path, owning group {string}, owning plugin {string}, and its {string} middleware",
    function* (endpoint: string, group: string, plugin: string, middleware: string) {
      const { outcomes } = yield* World;
      const [method, path] = endpoint.split(" ");
      const result = yield* lastRun;
      const row = result.stdout.find(
        (line) => line.startsWith(method ?? "") && line.includes(path ?? "\u0000"),
      );
      assert.ok(row !== undefined, `no row for ${endpoint}`);
      assert.match(row, new RegExp(`\\b${group}\\b`));
      assert.match(row, new RegExp(`\\b${plugin.toLowerCase()}\\b`));
      // The middleware chain the row carries is the contract's own: CSRF protection guards sign-in.
      assert.equal(middleware, "CsrfProtection");
      assert.match(row, new RegExp(Api.CsrfProtection.key.replace(/[/]/g, "\\/")));
      yield* outcomes.set("row", row);
    },
  );

  Given(
    "a composed {string} contract with a known number of endpoints across every installed plugin",
    function* (_api: string) {
      const { outcomes } = yield* World;
      yield* updateConfig({ auth: passwordAndRoles });
      let expected = 0;
      for (const group of Object.values(passwordAndRoles.api.groups)) {
        expected += Object.keys(group.endpoints).length;
      }
      yield* outcomes.set("expectedCount", expected);
    },
  );

  Then(
    "the listing contains exactly one row per endpoint in the contract, with none omitted",
    function* () {
      const { outcomes } = yield* World;
      const json = yield* runsFor("awthaq routes --json");
      const rows: unknown = JSON.parse(json.stdout.join("\n"));
      assert.ok(Array.isArray(rows));
      assert.equal(rows.length, yield* outcomes.getAs("expectedCount", isNumber));
    },
  );

  Given("a composed {string} contract", function* (_api: string) {
    yield* updateConfig({ auth: passwordAndRoles });
  });

  Then(
    "it produces its listing without making any HTTP request or running any handler",
    function* () {
      // The command ran with an `HttpClient` that fails on use (CliWorld.ts); it still listed the routes.
      const result = yield* lastRun;
      assert.equal(result.code, 0);
      assert.ok(result.stdout.length > 5);
    },
  );

  // ---- BEH-EA-204: migration status / apply -------------------------------------------------

  Given(
    "the linker's ordered, re-keyed migration record for the installed plugin set",
    function* () {
      yield* updateConfig({ auth: passwordAndRoles });
      const { outcomes } = yield* World;
      yield* outcomes.set("linkerCount", passwordAndRoles.migrations.length);
    },
  );

  Given(
    "the driver's {string} ledger showing some of those migrations already applied",
    function* (_migrator: string) {
      const { sql } = yield* World;
      yield* applyEverything;
      // The newest plugin migration is forgotten by the ledger, so it reads as pending.
      yield* sql`DELETE FROM awthaq_plugin_migrations WHERE migration_id = (SELECT max(migration_id) FROM awthaq_plugin_migrations)`;
    },
  );

  Then(
    "it reports each migration as applied or pending by comparing the linker's record against the ledger",
    function* () {
      const result = yield* lastRun;
      assert.equal(result.code, 0);
      const text = combined(result);
      assert.match(text, /core \(effect_sql_migrations\): \d+ applied, 0 pending/);
      assert.match(text, /plugins \(awthaq_plugin_migrations\): 1 applied, 1 pending/);
    },
  );

  Given("pending migrations reported by {string}", function* (command: string) {
    const { outcomes } = yield* World;
    yield* updateConfig({ auth: passwordAndRoles });
    const status = yield* runsFor(command);
    assert.equal(status.code, 0);
    assert.match(combined(status), /pending/);
    yield* outcomes.set("pendingBefore", (yield* tableNames).length);
  });

  When("{string} is run without the {string} flag", function* (command: string, _flag: string) {
    const { outcomes } = yield* World;
    yield* outcomes.set("ran", yield* runsFor(command));
  });

  Then("it refuses to apply any migration", function* () {
    const { outcomes } = yield* World;
    const result = yield* lastRun;
    assert.ok(result.code !== 0);
    const snapshot = yield* Effect.exit(outcomes.getAs("ledgerSnapshot", isNumberArray));
    if (snapshot._tag === "Success") {
      // A database that already held ledgers: they are exactly as they were.
      assert.deepEqual(
        [yield* countRows("effect_sql_migrations"), yield* countRows("awthaq_plugin_migrations")],
        snapshot.value,
      );
    } else {
      // A fresh database: nothing was created, not even a ledger.
      assert.deepEqual(yield* tableNames, []);
    }
  });

  Then("the pending migrations are applied", function* () {
    const result = yield* lastRun;
    assert.equal(result.code, 0);
    assert.ok(result.stdout.some((line) => line.startsWith("applied ")));
    assert.ok((yield* countRows("effect_sql_migrations")) > 0);
    assert.ok((yield* countRows("awthaq_plugin_migrations")) > 0);
  });

  Given(
    "an installed plugin set whose migrations are ordered core first, then topologically, keyed {string}",
    function* (_key: string) {
      yield* updateConfig({ auth: passwordAndRoles });
    },
  );

  Then("the migrations are applied in that exact fixed order", function* () {
    const { sql } = yield* World;
    const result = yield* lastRun;
    assert.equal(result.code, 0);
    const lines = result.stdout.filter((line) => line.startsWith("applied "));
    const firstPlugin = lines.findIndex(
      (line) => /awthaq_plugin_migrations|_roles_/i.test(line) || /^applied plugin/i.test(line),
    );
    const firstCore = lines.findIndex((line) => /effect_sql_migrations|^applied core/i.test(line));
    assert.ok(lines.length > 0);
    if (firstPlugin >= 0 && firstCore >= 0) assert.ok(firstCore < firstPlugin);
    // The ledgers agree: ids ascend in the order they ran.
    const core = yield* sql<{
      readonly migration_id: number;
    }>`SELECT migration_id FROM effect_sql_migrations ORDER BY rowid`;
    const ids = core.map((row) => row.migration_id);
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => a - b),
    );
    const plugin = yield* sql<{
      readonly migration_id: number;
    }>`SELECT migration_id FROM awthaq_plugin_migrations ORDER BY rowid`;
    const pluginIds = plugin.map((row) => row.migration_id);
    assert.deepEqual(
      pluginIds,
      [...pluginIds].sort((a, b) => a - b),
    );
  });

  Then("the ordered pending set is printed before any migration is applied", function* () {
    const result = yield* lastRun;
    const pending = result.stdout.findIndex((line) => line.includes("pending  "));
    const applied = result.stdout.findIndex((line) => line.startsWith("applied "));
    assert.ok(pending >= 0 && applied >= 0);
    assert.ok(pending < applied);
  });

  Then("the ordered pending set is printed", function* () {
    const result = yield* lastRun;
    assert.ok(result.stdout.filter((line) => line.includes("pending  ")).length > 0);
  });

  Then("no migration is applied", function* () {
    assert.deepEqual(yield* tableNames, []);
  });

  Given("a ledger holding an applied migration the linker's record does not contain", function* () {
    const { sql } = yield* World;
    yield* updateConfig({ auth: passwordAndRoles });
    yield* applyEverything;
    yield* sql`INSERT INTO awthaq_plugin_migrations (migration_id, name) VALUES (99, '0099_gone_plugin_migration')`;
    const { outcomes } = yield* World;
    yield* outcomes.set("ledgerSnapshot", [
      yield* countRows("effect_sql_migrations"),
      yield* countRows("awthaq_plugin_migrations"),
    ]);
  });

  Then("it fails with the drift exit code", function* () {
    assert.equal((yield* lastRun).code, EXIT.ledgerDrift);
  });

  Given("no pending migrations", function* () {
    yield* updateConfig({ auth: passwordAndRoles });
    yield* applyEverything;
  });

  Then("it exits with the nothing-to-apply code", function* () {
    assert.equal((yield* lastRun).code, EXIT.nothingToApply);
  });

  // ---- BEH-EA-205: openapi ------------------------------------------------------------------

  Given(
    "an installed plugin set including {string} and {string}",
    function* (_first: string, _second: string) {
      yield* updateConfig({ auth: withOAuth });
    },
  );

  const openapiDocument = Effect.gen(function* () {
    const result = yield* lastRun;
    const parsed: unknown = JSON.parse(result.stdout.join("\n"));
    const paths = Reflect.get(Object(parsed), "paths");
    return { parsed, paths: typeof paths === "object" && paths !== null ? Object.keys(paths) : [] };
  });

  Then(
    "it emits one OpenAPI document whose paths cover core's contract and both {string}'s and {string}'s contracts",
    function* (_first: string, _second: string) {
      const { paths } = yield* openapiDocument;
      assert.ok(
        paths.some((path) => path.endsWith("/session")),
        "core's session group",
      );
      assert.ok(
        paths.some((path) => path.endsWith("/password/sign-up")),
        "password's contract",
      );
      assert.ok(
        paths.some((path) => path.includes("/oauth/")),
        "oauth's contract",
      );
    },
  );

  Given(
    "a consumer that does not import {string} and wants to generate an HTTP client",
    function* (_module: string) {
      yield* updateConfig({ auth: withOAuth });
    },
  );

  When("that consumer uses the output of {string}", function* (command: string) {
    const { outcomes } = yield* World;
    yield* outcomes.set("ran", yield* runsFor(command));
  });

  Then("it receives the single aggregated document", function* () {
    const result = yield* lastRun;
    // Stdout is exactly one JSON document — not a stream of per-plugin ones.
    const parsed: unknown = JSON.parse(result.stdout.join("\n"));
    assert.equal(typeof Reflect.get(Object(parsed), "openapi"), "string");
  });

  Then(
    "it is never required to assemble or merge multiple per-plugin OpenAPI documents itself",
    function* () {
      const { paths } = yield* openapiDocument;
      // Both plugins' operations are in the one document it already has.
      assert.ok(
        paths.some((path) => path.includes("/oauth/")) &&
          paths.some((path) => path.includes("/password/")),
      );
    },
  );

  Given(
    "the composed {string} contract used to generate the Effect-based client",
    function* (_api: string) {
      yield* updateConfig({ auth: withOAuth });
    },
  );

  Then("the emitted document is generated from that same merged contract", function* () {
    const { parsed } = yield* openapiDocument;
    const paths = Reflect.get(Object(parsed), "paths");
    let operations = 0;
    for (const item of Object.values(Object(paths))) {
      operations += Object.keys(Object(item)).filter((key) =>
        ["get", "post", "put", "patch", "delete"].includes(key),
      ).length;
    }
    let declared = 0;
    for (const group of Object.values(withOAuth.api.groups)) {
      declared += Object.keys(group.endpoints).length;
    }
    // One operation per endpoint the merged contract declares — the same set the Effect client is built from.
    assert.equal(operations, declared);
  });

  // ---- BEH-EA-206: seed admin ---------------------------------------------------------------

  const prepareSeed = Effect.gen(function* () {
    const { app } = yield* World;
    yield* migrated;
    yield* updateConfig({ auth: passwordAndRoles, app, config: goodConfig });
  });

  Given("no administrative account exists yet", function* () {
    yield* prepareSeed;
  });

  When("{string} runs for account {string}", function* (command: string, email: string) {
    const { outcomes } = yield* World;
    yield* outcomes.set("ran", yield* runsFor(`${command} --email ${email}`));
  });

  Then(
    "the account is created or promoted to an administrative role through the {string} and {string} domain services",
    function* (_users: string, _roles: string) {
      const { sql } = yield* World;
      assert.equal((yield* lastRun).code, 0);
      const users = yield* sql<{ readonly email: string }>`SELECT email FROM users`;
      assert.deepEqual(
        users.map((row) => row.email),
        ["ops@acme.com"],
      );
      const held = yield* sql<{ readonly role: string }>`SELECT role FROM role_assignments`;
      assert.deepEqual(
        held.map((row) => row.role),
        ["admin"],
      );
    },
  );

  Given("{string} provisioning an account", function* (_command: string) {
    const { outcomes } = yield* World;
    yield* prepareSeed;
    yield* outcomes.set("pending", ["seed", "admin", "--email", "ops@acme.com"]);
  });

  Then(
    "it does not write rows to the database directly, bypassing {string} or {string}",
    function* (_users: string, _roles: string) {
      assert.equal((yield* lastRun).code, 0);
      const tags = yield* auditTags;
      // The rows arrived through the domain services: their own events are what carry the writes.
      assert.ok(tags.includes("auth.roles.assigned"), tags.join(","));
      assert.ok(tags.includes("auth.admin.seeded"), tags.join(","));
    },
  );

  Given("an administrative account already exists", function* () {
    yield* prepareSeed;
    const first = yield* runsFor("awthaq seed admin --email ops@acme.com");
    assert.equal(first.code, 0);
  });

  When("{string} runs without a force flag", function* (command: string) {
    const { outcomes } = yield* World;
    yield* outcomes.set("ran", yield* runsFor(command));
  });

  Then("it refuses to create or promote another administrative account", function* () {
    const { sql } = yield* World;
    assert.equal((yield* lastRun).code, EXIT.confirmationRequired);
    const users = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM users`;
    assert.equal(Number(users[0]?.n), 1);
  });

  Then("it proceeds to create or promote the requested account", function* () {
    const { sql } = yield* World;
    assert.equal((yield* lastRun).code, 0);
    const holders = yield* sql<{
      readonly n: number;
    }>`SELECT count(*) AS n FROM role_assignments WHERE role = 'admin'`;
    assert.equal(Number(holders[0]?.n), 2);
  });

  Given("an installed plugin set that does not include {string}", function* (_plugin: string) {
    const { sql } = yield* World;
    yield* migrated;
    yield* updateConfig({ auth: Auth.make([Password.Password]), app: sqlAppWithoutRoles(sql) });
  });

  Then("there is no administrative role concept for it to grant", function* () {
    const { sql } = yield* World;
    const result = yield* lastRun;
    assert.equal(result.code, EXIT.unavailable);
    assert.match(combined(result), /Roles/);
    const users = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM users`;
    assert.equal(Number(users[0]?.n), 0);
  });

  Then("an {string} event is published and recorded in the audit table", function* (tag: string) {
    const tags = yield* auditTags;
    assert.ok(tags.includes(tag), `${tag} not among ${tags.join(",")}`);
  });

  Given("an installed plugin set with {string}", function* (_plugin: string) {
    const { outcomes } = yield* World;
    const counter = { n: 0 };
    yield* outcomes.set("counter", counter);
    yield* updateConfig({
      auth: passwordAndRoles,
      // If any service were constructed, this Layer would be built and counted.
      app: Layer.effectDiscard(
        Effect.sync(() => {
          counter.n += 1;
        }),
      ),
    });
  });

  Then("it fails with the usage exit code before any service is constructed", function* () {
    const { outcomes } = yield* World;
    assert.equal((yield* lastRun).code, EXIT.usage);
    assert.equal((yield* outcomes.getAs("counter", isCounter)).n, 0);
  });

  // ---- BEH-EA-207: import (only what needs no exported fixture) -----------------------------

  Given("no adapter registered under {string}", function* (name: string) {
    const { outcomes } = yield* World;
    yield* updateConfig({ auth: passwordAndRoles, config: goodConfig });
    yield* outcomes.set("unknownSource", name);
  });

  Then("it fails with the usage exit code listing the supported sources", function* () {
    const { outcomes } = yield* World;
    const result = yield* lastRun;
    assert.ok(result.argv.includes(yield* outcomes.getAs("unknownSource", isString)));
    assert.equal(result.code, EXIT.usage);
    assert.match(combined(result), /better-auth/);
    assert.match(combined(result), /firebase/);
  });

  Given(
    "a registered adapter for {string} that has not been validated against a real export",
    function* (_framework: string) {
      yield* updateConfig({ auth: passwordAndRoles, config: goodConfig });
    },
  );

  Then("it is refused with a typed not-yet-validated error", function* () {
    const result = yield* lastRun;
    assert.equal(result.code, EXIT.usage);
    assert.match(combined(result), /not (yet )?validated|NotYetValidated/i);
  });

  Given(
    "an application composing {string}, {string}, and {string}",
    function* (_make: string, _layer: string, _migrations: string) {
      const { outcomes } = yield* World;
      yield* outcomes.set("composed", Object.keys(passwordAndRoles.api.groups).length);
    },
  );

  When("the application boots", function* () {
    const { outcomes } = yield* World;
    // Which workspace packages does a runtime package (everything but the CLI itself) depend on?
    const dependents: Array<string> = [];
    for (const entry of readdirSync(packagesDir)) {
      if (entry === "cli") continue;
      const manifest: unknown = JSON.parse(
        readFileSync(Path.join(packagesDir, entry, "package.json"), "utf8"),
      );
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        const deps = Reflect.get(Object(manifest), field);
        if (deps !== undefined && "@awthaq/cli" in Object(deps)) dependents.push(entry);
      }
    }
    yield* outcomes.set("cliDependents", dependents);
  });

  Then("it does not depend on {string} existing", function* (_command: string) {
    const { outcomes } = yield* World;
    assert.deepEqual(yield* outcomes.getAs("cliDependents", isStringArray), []);
  });

  // ---- BEH-EA-208: the CLI reads the manifest; it never runs the application ---------------

  Given(
    "{string}'s statically derived manifest for an installed plugin set",
    function* (_make: string) {
      const { outcomes } = yield* World;
      const counter = { n: 0 };
      yield* outcomes.set("counter", counter);
      yield* updateConfig({
        auth: passwordAndRoles,
        config: goodConfig,
        // Booby-trapped: building the application Layer would count it.
        app: Layer.effectDiscard(
          Effect.sync(() => {
            counter.n += 1;
          }),
        ),
      });
    },
  );

  Then(
    "it operates on the manifest's contract, tables, migrations, or plugin graph without evaluating the plugin set's runtime {string} Layer",
    function* (_make: string) {
      const { outcomes } = yield* World;
      const result = yield* lastRun;
      // It answered (doctor may report findings, exit 3, but never "unavailable")...
      assert.ok(
        result.code === 0 || result.code === EXIT.doctorFindings,
        `exit ${result.code}: ${combined(result)}`,
      );
      assert.ok(result.stdout.length > 0);
      // ...without ever building the application Layer.
      assert.equal((yield* outcomes.getAs("counter", isCounter)).n, 0);
    },
  );

  Then(
    "it does not start an HTTP listener, accept an inbound request, or otherwise serve the application it acts on",
    function* () {
      const { outcomes } = yield* World;
      assert.equal(yield* outcomes.getAs("listeners", isNumber), 0);
    },
  );

  Given("an application defining {string}", function* (_definition: string) {
    const { outcomes } = yield* World;
    yield* outcomes.set("defined", true);
  });

  When("the module is evaluated", function* () {
    const { outcomes } = yield* World;
    const watch = watchListeners();
    try {
      const auth = Auth.make([
        Password.Password,
        Passkey.Passkey,
        OAuth.OAuth,
        Organization.Organization,
        Roles.Roles,
      ]);
      yield* outcomes.set(
        "manifestIds",
        auth.manifest.plugins.map((plugin) => plugin.id),
      );
      yield* updateConfig({ auth, sql: undefined, app: undefined });
    } finally {
      yield* outcomes.set("listeners", watch.started());
      watch.stop();
    }
  });

  Then("{string} is available for the CLI to read", function* (_manifest: string) {
    const { outcomes } = yield* World;
    const ids = yield* outcomes.getAs("manifestIds", isStringArray);
    for (const id of ["password", "passkey", "oauth", "organization", "roles"]) {
      assert.ok(ids.includes(id), `${id} missing from ${ids.join(",")}`);
    }
    // The CLI answers from it with no database and no application configured.
    const graph = yield* runsFor("awthaq plugin list --graph");
    assert.equal(graph.code, 0);
    assert.match(combined(graph), /organization/);
  });

  Then(
    "no HTTP listener needs to be started and no database connection needs to be live for a manifest-only CLI command to answer correctly",
    function* () {
      const { outcomes } = yield* World;
      assert.equal(yield* outcomes.getAs("listeners", isNumber), 0);
    },
  );

  Given(
    "a database-backed command among {string}, {string}, {string} and {string}",
    function* (first: string, _second: string, _third: string, _fourth: string) {
      const { app } = yield* World;
      assert.equal(first, "migration status");
      yield* migrated;
      yield* updateConfig({ auth: passwordAndRoles, app, config: goodConfig });
    },
  );

  When("the command runs", function* () {
    const { outcomes } = yield* World;
    const watch = watchListeners();
    try {
      const status = yield* runsFor("awthaq migration status");
      const seed = yield* runsFor("awthaq seed admin --email ops@acme.com");
      yield* outcomes.set("dbCodes", [status.code, seed.code]);
    } finally {
      yield* outcomes.set("listeners", watch.started());
      watch.stop();
    }
  });

  Then(
    "it may construct the SqlClient and the Users, Roles and Accounts domain-service Layers",
    function* () {
      const { outcomes, sql } = yield* World;
      assert.deepEqual(yield* outcomes.getAs("dbCodes", isNumberArray), [0, 0]);
      // The seed really went through those services: the user and role rows exist.
      const users = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM users`;
      assert.equal(Number(users[0]?.n), 1);
    },
  );

  Then("it never builds the HTTP server Layer", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("listeners", isNumber), 0);
    // And the CLI's own source never reaches for one: no HttpServer/HttpRouter/serve import anywhere in it.
    const srcDir = Path.join(packagesDir, "cli/src");
    const offenders = readdirSync(srcDir)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) =>
        /NodeHttpServer|http\/HttpServer\b|HttpRouter\.serve|HttpApiBuilder\.layer\b/.test(
          readFileSync(Path.join(srcDir, file), "utf8"),
        ),
      );
    assert.deepEqual(offenders, []);
  });

  // ---- BEH-EA-225: exit codes ---------------------------------------------------------------

  /** Sets up a real command that ends in the named typed failure, and records the argv to run. */
  const arrangeFailure = (error: string) =>
    Effect.gen(function* () {
      const { outcomes, sql } = yield* World;
      const arrange = (argv: ReadonlyArray<string>) => outcomes.set("pending", argv);
      switch (error) {
        case "DoctorFindings":
          yield* updateConfig({ auth: widgetOnly });
          return yield* arrange(["doctor"]);
        case "NothingToApply":
          yield* updateConfig({ auth: passwordAndRoles });
          yield* applyEverything;
          return yield* arrange(["migration", "apply", "--yes"]);
        case "ConfirmationRequired":
          yield* updateConfig({ auth: passwordAndRoles });
          return yield* arrange(["migration", "apply"]);
        case "LedgerDrift":
          yield* updateConfig({ auth: passwordAndRoles });
          yield* applyEverything;
          yield* sql`INSERT INTO awthaq_plugin_migrations (migration_id, name) VALUES (99, '0099_gone_plugin_migration')`;
          return yield* arrange(["migration", "status"]);
        case "AuthenticationRequired":
          yield* updateConfig({ auth: passwordAndRoles });
          return yield* arrange(["whoami"]);
        case "ConfigUnavailable":
          // A database-backed command with no database configured anywhere.
          yield* updateConfig({ auth: passwordAndRoles, sql: undefined });
          return yield* arrange(["migration", "status"]);
        default:
          return yield* Effect.die(new Error(`no way to provoke ${error}`));
      }
    });

  Given("a CLI command that fails with {string}", function* (error: string) {
    yield* arrangeFailure(error);
  });

  const runPending = Effect.gen(function* () {
    const { outcomes } = yield* World;
    const argv = yield* outcomes.getAs("pending", isStringArray);
    yield* outcomes.set("ran", yield* runCommand(argv));
  });

  When("it exits", function* () {
    yield* runPending;
  });

  Then("the process exit status is {int}", function* (code: number) {
    assert.equal((yield* lastRun).code, code);
  });

  Given("a configuration with no findings", function* () {
    yield* updateConfig({ auth: passwordAndRoles, config: goodConfig, production: undefined });
  });

  Then("the process exits with status {int}", function* (code: number) {
    assert.equal((yield* lastRun).code, code);
  });

  Given("a command invoked with an unknown flag", function* () {
    const { outcomes } = yield* World;
    yield* updateConfig({ auth: passwordAndRoles, config: goodConfig });
    yield* outcomes.set("pending", ["doctor", "--no-such-flag"]);
  });

  When("it runs", function* () {
    yield* runPending;
  });

  Then("the process exits with the usage code", function* () {
    assert.equal((yield* lastRun).code, EXIT.usage);
  });

  Given("a failing command run with {string}", function* (flag: string) {
    const { outcomes } = yield* World;
    yield* updateConfig({ auth: widgetOnly });
    yield* outcomes.set("pending", ["doctor", flag]);
  });

  When("it fails", function* () {
    yield* runPending;
  });

  Then("the failure document carries the same {string} and exit code", function* (field: string) {
    assert.equal(field, "_tag");
    const result = yield* lastRun;
    const failure: unknown = JSON.parse(result.stderr[0] ?? "null");
    assert.equal(Reflect.get(Object(failure), "_tag"), "DoctorFindings");
    assert.equal(Reflect.get(Object(failure), "code"), result.code);
    assert.equal(result.code, EXIT.doctorFindings);
  });

  // ---- BEH-EA-226: arguments decode through Schemas ----------------------------------------

  Given("the CLI's command tree", function* () {
    yield* updateConfig({ auth: passwordAndRoles, config: goodConfig });
  });

  When("its flags and arguments are inspected", function* () {
    const { outcomes } = yield* World;
    // Each typed input is fed a value its Schema refuses; a flag that bypassed its Schema would be accepted.
    const bad: ReadonlyArray<ReadonlyArray<string>> = [
      ["seed", "admin", "--email", "not-an-email"],
      ["migration", "status", "--database-url", "mysql://x"],
      ["plugin", "list", "--format", "yaml"],
    ];
    const codes: Array<number> = [];
    for (const argv of bad) codes.push(yield* exitCodeOf(argv));
    yield* outcomes.set("refusals", codes);
  });

  Then("each one decodes through a Schema", function* () {
    const { outcomes } = yield* World;
    assert.deepEqual(yield* outcomes.getAs("refusals", isNumberArray), [
      EXIT.usage,
      EXIT.usage,
      EXIT.usage,
    ]);
  });

  Given("the password sign-up payload's email Schema", function* () {
    yield* updateConfig({ auth: passwordAndRoles, config: goodConfig });
  });

  When("{string} decodes its argument", function* (_command: string) {
    const { outcomes } = yield* World;
    const samples = [
      "ops@acme.com",
      "not-an-email",
      "a@b",
      "UPPER@EXAMPLE.COM",
      "two words@acme.com",
      "",
    ];
    const verdicts: Array<string> = [];
    for (const sample of samples) {
      const code = yield* exitCodeOf(["seed", "admin", "--email", sample]);
      // Usage (exit 2) means the CLI's Schema refused it; anything else means it was accepted and the command went on.
      verdicts.push(
        `${sample}=>${code === EXIT.usage ? "rejected" : "accepted"}|${emailAccepted(sample) ? "accepted" : "rejected"}`,
      );
    }
    yield* outcomes.set("verdicts", verdicts);
  });

  Then("it accepts and rejects exactly the values that Schema accepts and rejects", function* () {
    const { outcomes } = yield* World;
    const verdicts = yield* outcomes.getAs("verdicts", isStringArray);
    for (const verdict of verdicts) {
      const [, both = ""] = verdict.split("=>");
      const [cli, schema] = both.split("|");
      assert.equal(cli, schema, verdict);
    }
    // The sample set really exercised both outcomes.
    assert.ok(verdicts.some((verdict) => verdict.includes("=>accepted|accepted")));
    assert.ok(verdicts.some((verdict) => verdict.includes("=>rejected|rejected")));
  });

  // ---- BEH-EA-227: session commands ----------------------------------------------------------

  Given("no stored credential and no {string}", function* (variable: string) {
    assert.equal(variable, "AWTHAQ_TOKEN");
    assert.equal(process.env["AWTHAQ_TOKEN"], undefined);
    yield* updateConfig({ auth: passwordAndRoles });
  });

  Then("it fails with the authentication code", function* () {
    assert.equal((yield* lastRun).code, EXIT.authenticationRequired);
  });

  // ---- BEH-EA-229: configuration is declared statically -------------------------------------

  Given("an installed plugin that declares a configuration descriptor", function* () {
    yield* updateConfig({ auth: widgetOnly });
  });

  When("{string} is evaluated", function* (_make: string) {
    const { outcomes } = yield* World;
    // `widgetOnly` was evaluated when this module loaded: nothing built a Layer, and its manifest is already there.
    yield* outcomes.set("manifestConfig", JSON.stringify(widgetOnly.manifest.config));
  });

  Then("{string} lists the descriptor without evaluating any Layer", function* (_path: string) {
    const { outcomes } = yield* World;
    const listed = yield* outcomes.getAs("manifestConfig", isString);
    assert.match(listed, /features\/cli\/WidgetConfig/);
    assert.match(listed, /clientSecret/);
  });

  Given("a configuration Layer setting a value declared sensitive", function* () {
    yield* updateConfig({ auth: widgetOnly, config: secretConfig });
  });

  Then("the sensitive value is printed as {string}", function* (redaction: string) {
    const result = yield* lastRun;
    assert.equal(result.code, 0);
    assert.match(combined(result), new RegExp(`clientSecret = ${redaction}`));
    assert.equal(combined(result).includes("sk-canary-123"), false);
  });
});

const isCounter = (value: unknown): value is { n: number } =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "n") === "number";

const isNumberArray = (value: unknown): value is ReadonlyArray<number> =>
  Array.isArray(value) && value.every((item) => typeof item === "number");
