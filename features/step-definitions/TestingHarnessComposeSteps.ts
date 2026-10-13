// BEH-EA-331..333 and 336 (25-testing-harness.feature): `TestAuth.layer` derives the host middleware, runs the same
// composition over memory and over SQL, `TestAuth.app` shares one context between its handler and its runner, and
// `pnpm check:contract-tests` fails a plugin package with no contract-test call. The compile-time claims of
// BEH-EA-334/335 are `PluginTypeGates.ts`'s.
import { TestAuth } from "@awthaq/test";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  LedgerRecords,
  fixedOperator,
  ledgerBuilt,
  operatorBuilt,
} from "./TestingHarnessComposeFixtures.ts";
import { World } from "./TestingHarnessWorld.ts";
import { isNumber, isString, isStringArray } from "./shared/Outcomes.ts";

const adminRequest = (handler: (request: Request) => Promise<Response>, cookie?: string) =>
  handler(
    new Request("http://localhost/operator/whoami", {
      headers: cookie === undefined ? {} : { cookie },
    }),
  );

/** Posts one entry and lists the ledger back, as a signed-in caller would. */
const roundTrip = (app: ReturnType<typeof TestAuth.app>, email: string, entry: string) =>
  Effect.promise(async () => {
    const signedIn = await app.signIn(email);
    const added = await app.request("POST", "/ledger", {
      cookie: signedIn.cookieHeader,
      json: { entry },
    });
    const listed = await app.request("GET", "/ledger", { cookie: signedIn.cookieHeader });
    return { added: added.status, listed: await listed.json() };
  });

const isRoundTrip = (value: unknown): value is { added: number; listed: ReadonlyArray<string> } =>
  typeof value === "object" &&
  value !== null &&
  isNumber(Reflect.get(value, "added")) &&
  isStringArray(Reflect.get(value, "listed"));

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
      const app = TestAuth.app(TestAuth.layer(operatorBuilt));
      const anonymous = yield* Effect.promise(() => adminRequest(app.handler));
      const signedIn = yield* Effect.promise(() => app.signIn("admin@example.com"));
      const authenticated = yield* Effect.promise(() =>
        adminRequest(app.handler, signedIn.cookieHeader),
      );
      yield* Effect.promise(() => app.dispose());
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
      const app = TestAuth.app(TestAuth.layer(operatorBuilt, { services: fixedOperator }));
      const anonymous = yield* Effect.promise(() => adminRequest(app.handler));
      const body = yield* Effect.promise(() => anonymous.text());
      yield* Effect.promise(() => app.dispose());
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
      const memory = TestAuth.app(TestAuth.layer(ledgerBuilt));
      const sql = TestAuth.app(
        TestAuth.layer(ledgerBuilt, { records: "sql", suite: "features_testing_harness_compose" }),
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
      yield* Effect.promise(() => memory.dispose());
      yield* Effect.promise(() => sql.dispose());
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
      const app = TestAuth.app(TestAuth.layer(ledgerBuilt));
      const signedIn = yield* Effect.promise(() => app.signIn("shared@example.com"));
      const response = yield* Effect.promise(() =>
        app.handler(
          new Request("http://localhost/ledger", { headers: { cookie: signedIn.cookieHeader } }),
        ),
      );
      yield* Effect.promise(() => app.dispose());
      yield* outcomes.set("handlerStatus", response.status);
    },
  );

  Then("the handler authenticates the request", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("handlerStatus", isNumber), 200);
  });

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

  Then("it exits zero", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("status", isNumber), 0);
  });
});
