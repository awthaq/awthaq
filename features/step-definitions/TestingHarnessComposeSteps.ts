// BEH-EA-331..333 and 336 (25-testing-harness.feature): `TestAuth.layer` derives the host middleware, runs the same
// composition over memory and over SQL, `TestAuth.serve` shares one context between its handler and its runner, and
// `pnpm check:contract-tests` fails a plugin package with no contract-test call. The compile-time claims of
// BEH-EA-334/335 are `PluginTypeGates.ts`'s.
import { AuthEvents } from "@awthaq/core";
import { ClientAddress, PasswordHasher, RateLimiter } from "@awthaq/ports";
import { AuthHost, Csrf } from "@awthaq/server";
import { RedactionGuard, TestAuth, TestMailbox } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as SqlClient from "effect/sql/SqlClient";
import {
  LedgerRecords,
  fixedOperator,
  ledgerBuilt,
  operatorBuilt,
} from "./TestingHarnessComposeFixtures.ts";
import { World } from "./TestingHarnessWorld.ts";
import { isNumber, isString, isStringArray } from "./shared/Outcomes.ts";

/** `GET /operator/whoami` from `browser` (a signed-in agent), or anonymously through the raw handler. */
const adminRequest = (
  handler: (request: Request) => Promise<Response>,
  browser?: TestAuth.SignedInAgent,
) =>
  browser === undefined
    ? handler(new Request("http://localhost/operator/whoami"))
    : browser.request("GET", "/operator/whoami");

/** Posts one entry and lists the ledger back, as a signed-in caller would. */
const roundTrip = (
  app: Pick<TestAuth.App<TestAuth.AppNeeds>, "signIn">,
  email: string,
  entry: string,
) =>
  Effect.promise(async () => {
    const caller = await app.signIn(email);
    const added = await caller.request("POST", "/ledger", { json: { entry } });
    const listed = await caller.request("GET", "/ledger");
    return { added: added.status, listed: await listed.json() };
  });

const isRoundTrip = (value: unknown): value is { added: number; listed: ReadonlyArray<string> } =>
  typeof value === "object" &&
  value !== null &&
  isNumber(Reflect.get(value, "added")) &&
  isStringArray(Reflect.get(value, "listed"));

const isNumberArray = (value: unknown): value is ReadonlyArray<number> =>
  Array.isArray(value) && value.every(isNumber);

/** A World's app cell, as the BEH-EA-352 scenario stores it between steps. */
const isCell = (value: unknown): value is TestAuth.LazyApp<{ readonly label: string }, unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "configure") === "function";

/** The service keys a layer's built context holds. */
const keysOf = <A, E>(layer: Layer.Layer<A, E>) =>
  Effect.scoped(
    Effect.map(Layer.build(layer), (context: Context.Context<A>) =>
      Array.from(context.mapUnsafe.keys()).sort(),
    ),
  );

/** `AuthHost.layer` over the same ports `TestAuth` provides (only the keys matter) and the HTTP platform. */
const hostedLedger = AuthHost.layer(ledgerBuilt, {
  persistence: { records: "memory" },
  csrf: Layer.succeed(Csrf.CsrfConfig, TestAuth.TestCsrfConfig),
  bodyLimit: false,
}).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      PasswordHasher.layerArgon2id.pipe(Layer.orDie),
      TestMailbox.layer,
      RateLimiter.layerPermissive,
      ClientAddress.layerDirect,
      TestAuth.encryption,
    ).pipe(Layer.provideMerge(NodeCrypto.layer)),
  ),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provideMerge(HttpRouter.layer),
);

export const testingHarnessComposeSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-331 -------------------------------------------------------------------------

  Given(
    "a composition whose only plugin declares an admin-tier group behind {string}",
    function* (middleware: string) {
      yield* Effect.void;
      assert.equal(middleware, "AdminAuthentication");
      const groups = Object.keys(operatorBuilt.api.groups);
      assert.ok(groups.includes("operator.admin"));
    },
  );

  When(
    "it is served through {string} with no {string}",
    function* (_entry: string, _option: string) {
      const { outcomes } = yield* World;
      const app = yield* TestAuth.serve(TestAuth.layer(operatorBuilt));
      const anonymous = yield* Effect.promise(() => adminRequest(app.handler));
      const signedIn = yield* Effect.promise(() => app.signIn("admin@example.com"));
      const authenticated = yield* Effect.promise(() => adminRequest(app.handler, signedIn));
      yield* outcomes.set("anonymousStatus", anonymous.status);
      yield* outcomes.set("authenticatedStatus", authenticated.status);
    },
  );

  Then(
    "a signed-in request to the admin endpoint is answered {int} and an anonymous one {int}",
    function* (signedIn: number, anonymous: number) {
      const { outcomes } = yield* World;
      assert.equal(yield* outcomes.getAs("authenticatedStatus", isNumber), signedIn);
      assert.equal(yield* outcomes.getAs("anonymousStatus", isNumber), anonymous);
    },
  );

  When(
    "the test supplies its own {string} in {string}",
    function* (_service: string, _option: string) {
      const { outcomes } = yield* World;
      const app = yield* TestAuth.serve(TestAuth.layer(operatorBuilt, { services: fixedOperator }));
      const anonymous = yield* Effect.promise(() => adminRequest(app.handler));
      const body = yield* Effect.promise(() => anonymous.text());
      yield* outcomes.set("overrideStatus", anonymous.status);
      yield* outcomes.set("overrideBody", body);
    },
  );

  Then("an anonymous request is admitted as the test's operator", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("overrideStatus", isNumber), 200);
    assert.ok((yield* outcomes.getAs("overrideBody", isString)).includes("operator-1"));
  });

  // ---- BEH-EA-332 -------------------------------------------------------------------------

  Given("a plugin that declares a {string} bundle", function* (bundle: string) {
    yield* Effect.void;
    assert.equal(bundle, "records");
    assert.ok(ledgerBuilt.plugins[0].records.memory !== ledgerBuilt.plugins[0].records.sql);
  });

  When(
    "the same requests run over {string} records and over {string} records",
    function* (_first: string, _second: string) {
      const { outcomes } = yield* World;
      const memory = yield* TestAuth.serve(TestAuth.layer(ledgerBuilt));
      const sql = yield* TestAuth.serve(
        TestAuth.layer(ledgerBuilt, {
          records: "sql",
          suite: "features_testing_harness_compose",
        }),
      );
      const overMemory = yield* roundTrip(memory, "memory@example.com", "first");
      const overSql = yield* roundTrip(sql, "sql@example.com", "first");
      const rows = yield* Effect.promise(() =>
        sql.run(
          Effect.flatMap(
            SqlClient.SqlClient,
            (client) => client<{ readonly entry: string }>`SELECT entry FROM ledger_entry`,
          ),
        ),
      );
      yield* outcomes.set("overMemory", overMemory);
      yield* outcomes.set("overSql", overSql);
      yield* outcomes.set(
        "sqlRows",
        rows.map((row) => row.entry),
      );
    },
  );

  Then("both answer identically and the row is in the migrated database", function* () {
    const { outcomes } = yield* World;
    const overMemory = yield* outcomes.getAs("overMemory", isRoundTrip);
    const overSql = yield* outcomes.getAs("overSql", isRoundTrip);
    assert.deepEqual(overMemory, overSql);
    assert.equal(overSql.added, 200);
    assert.deepEqual(overSql.listed, ["first"]);
    assert.deepEqual(yield* outcomes.getAs("sqlRows", isStringArray), ["first"]);
    assert.ok(LedgerRecords.key.includes("/records/"));
  });

  // ---- BEH-EA-333 -------------------------------------------------------------------------

  Given("a composition served through {string}", function* (_entry: string) {
    yield* Effect.void;
  });

  When(
    "a session is minted through the app's context runner and used on its handler",
    function* () {
      const { outcomes } = yield* World;
      const app = yield* TestAuth.serve(TestAuth.layer(ledgerBuilt));
      const signedIn = yield* Effect.promise(() => app.signIn("shared@example.com"));
      // The agent holds the session minted through `run`; its request goes through the app's handler.
      const response = yield* Effect.promise(() => signedIn.request("GET", "/ledger"));
      yield* outcomes.set("handlerStatus", response.status);
    },
  );

  Then("the handler authenticates the request", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("handlerStatus", isNumber), 200);
  });

  // ---- BEH-EA-351..353 --------------------------------------------------------------------

  When("the scope that served it closes", function* () {
    const { outcomes } = yield* World;
    // Relative, never absolute: other Worlds of the run may be mid-scenario.
    const before = TestAuth.openApps();
    const during = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* TestAuth.serve(TestAuth.layer(ledgerBuilt));
        return TestAuth.openApps();
      }),
    );
    yield* outcomes.set("appsDelta", [during - before, TestAuth.openApps() - before]);
  });

  Then("no test app is left open", function* () {
    const { outcomes } = yield* World;
    const delta = yield* outcomes.getAs("appsDelta", isNumberArray);
    assert.deepEqual(delta, [1, 0]);
  });

  Given("a World's app cell that has served a request", function* () {
    const { outcomes } = yield* World;
    const cell = yield* TestAuth.lazyApp(
      { label: "initial" },
      () => TestAuth.serve(TestAuth.layer(ledgerBuilt)),
      { name: "HarnessWorld" },
    );
    yield* cell.get;
    yield* outcomes.set("cell", cell);
  });

  When("the scenario configures the cell", function* () {
    const { outcomes } = yield* World;
    const cell = yield* outcomes.getAs("cell", isCell);
    const exit = yield* Effect.exit(cell.configure((current) => ({ ...current, label: "late" })));
    yield* outcomes.set("configureFailure", Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
  });

  Then("the step fails naming the World", function* () {
    const { outcomes } = yield* World;
    assert.ok((yield* outcomes.getAs("configureFailure", isString)).includes("HarnessWorld"));
  });

  When("a client fetches {string} over the socket", function* (route: string) {
    const { outcomes } = yield* World;
    const listening = yield* TestAuth.listen(TestAuth.layer(ledgerBuilt));
    const response = yield* Effect.promise(() => fetch(`${listening.url}${route}`));
    yield* outcomes.set("socketStatus", response.status);
    yield* outcomes.set("socketLog", listening.requests().join("\n"));
  });

  Then(
    "it is refused with {int} and the app's request log lists {string}",
    function* (status: number, line: string) {
      const { outcomes } = yield* World;
      assert.equal(yield* outcomes.getAs("socketStatus", isNumber), status);
      assert.ok((yield* outcomes.getAs("socketLog", isString)).split("\n").includes(line));
    },
  );

  // ---- BEH-EA-336 -------------------------------------------------------------------------

  Given(
    "a plugin package whose class extends {string} and whose tests never call {string}",
    function* (_base: string, _call: string) {
      const { outcomes } = yield* World;
      const root = mkdtempSync(path.join(tmpdir(), "awthaq-contract-tests-"));
      mkdirSync(path.join(root, "packages", "demo", "src"), { recursive: true });
      mkdirSync(path.join(root, "packages", "demo", "test"), { recursive: true });
      mkdirSync(path.join(root, "examples"), { recursive: true });
      writeFileSync(
        path.join(root, "packages", "demo", "src", "Demo.ts"),
        'export class Demo extends AuthPlugin.Service<Demo, {}>()("demo", {}) {}\n',
      );
      yield* outcomes.set("root", root);
    },
  );

  const runCheck = (root: string) =>
    spawnSync(
      process.execPath,
      [path.join(process.cwd(), "..", "scripts", "check-contract-tests.mjs")],
      {
        env: { ...process.env, AWTHAQ_CONTRACT_TESTS_ROOT: root },
        encoding: "utf8",
      },
    );

  When("the script {string} runs", function* (_script: string) {
    const { outcomes } = yield* World;
    const root = yield* outcomes.getAs("root", isString);
    const result = runCheck(root);
    yield* outcomes.set("status", result.status ?? -1);
    yield* outcomes.set("report", `${result.stderr}${result.stdout}`);
  });

  Then("it exits non-zero, naming the class", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("status", isNumber), 1);
    assert.ok((yield* outcomes.getAs("report", isString)).includes("Demo"));
  });

  When(
    "the package's {string} calls {string} for the class",
    function* (file: string, _call: string) {
      const { outcomes } = yield* World;
      const root = yield* outcomes.getAs("root", isString);
      writeFileSync(
        path.join(root, "packages", "demo", file),
        "TestAuth.runPluginContractTests(framework, () => Demo.Demo, { options: [{}] });\n",
      );
      const result = runCheck(root);
      rmSync(root, { recursive: true, force: true });
      yield* outcomes.set("status", result.status ?? -1);
    },
  );

  // Plan 37 (BEH-EA-336, superseding plan 25): scripts/test-pg.sh runs every suite, so it names no test file.
  Given(
    "a plugin package whose {string} runs the contract suite and whose {string} names {string}",
    function* (file: string, script: string, named: string) {
      const { outcomes } = yield* World;
      const root = mkdtempSync(path.join(tmpdir(), "awthaq-contract-tests-"));
      mkdirSync(path.join(root, "packages", "demo", "src"), { recursive: true });
      mkdirSync(path.join(root, "packages", "demo", "test"), { recursive: true });
      mkdirSync(path.join(root, "scripts"), { recursive: true });
      mkdirSync(path.join(root, "examples"), { recursive: true });
      writeFileSync(
        path.join(root, "packages", "demo", "src", "Demo.ts"),
        'export class Demo extends AuthPlugin.Service<Demo, {}>()("demo", {}) {}\n',
      );
      writeFileSync(
        path.join(root, "packages", "demo", file),
        "TestAuth.runPluginContractTests(framework, () => Demo.Demo, { options: [{}] });\n",
      );
      writeFileSync(path.join(root, script), `suites=(\n  ${named}\n)\n`);
      yield* outcomes.set("root", root);
    },
  );

  Then("it exits non-zero, naming {string} and {string}", function* (file: string, script: string) {
    const { outcomes } = yield* World;
    const root = yield* outcomes.getAs("root", isString);
    rmSync(root, { recursive: true, force: true });
    assert.equal(yield* outcomes.getAs("status", isNumber), 1);
    const report = yield* outcomes.getAs("report", isString);
    assert.ok(report.includes(file) && report.includes(script), report);
  });

  When("{string} names no test file", function* (script: string) {
    const { outcomes } = yield* World;
    const root = yield* outcomes.getAs("root", isString);
    writeFileSync(path.join(root, script), "pnpm exec vitest run\n");
    const result = runCheck(root);
    rmSync(root, { recursive: true, force: true });
    yield* outcomes.set("status", result.status ?? -1);
  });

  Then("it exits zero", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("status", isNumber), 0);
  });

  // ---- BEH-EA-342 ---------------------------------------------------------------------------

  Given(
    "one composition built through {string} and through {string} over the same ports",
    function* (harness: string, host: string) {
      yield* Effect.void; // an assertion-only step: the When builds both
      assert.deepEqual([harness, host], ["TestAuth.layer", "AuthHost.layer"]);
    },
  );

  When("both are built", function* () {
    const { outcomes } = yield* World;
    yield* outcomes.set("harnessKeys", yield* keysOf(TestAuth.layer(ledgerBuilt)));
    yield* outcomes.set("hostKeys", yield* keysOf(hostedLedger));
    yield* outcomes.set("guardKeys", yield* keysOf(RedactionGuard.layer));
  });

  Then(
    "the harness holds every service the host composition holds, plus only the redaction guard's and the undeclared-event policy",
    function* () {
      const { outcomes } = yield* World;
      const harness = yield* outcomes.getAs("harnessKeys", isStringArray);
      const host = yield* outcomes.getAs("hostKeys", isStringArray);
      const guard = yield* outcomes.getAs("guardKeys", isStringArray);
      assert.deepEqual(
        host.filter((key) => !harness.includes(key)),
        [],
      );
      // ADR-EA-049: the harness also sets `UndeclaredEventPolicy` to "die", so a plugin that emits an event it did
      // not declare fails its own tests.
      assert.deepEqual(
        harness.filter((key) => !host.includes(key)).toSorted(),
        [
          ...guard.filter((key) => !host.includes(key)),
          AuthEvents.UndeclaredEventPolicy.key,
        ].toSorted(),
      );
    },
  );
});
