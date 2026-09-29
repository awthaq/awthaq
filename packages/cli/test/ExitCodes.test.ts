// BEH-EA-225 (ECS-001, CTA-003) and BEH-EA-226 (ECS-007): the real command tree run in-process,
// asserting the exit code each typed failure ends the process with, and that a bad argument is a
// usage error decided before any service is built.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as CliErrors from "../src/CliErrors.ts";
import { runCli } from "./support/RunCli.ts";
import { configOf, passwordAndRoles } from "./support/TestApp.ts";
import { widgetOnly } from "./support/WidgetPlugin.ts";
import { Roles } from "@awthaq/roles";
import { role } from "@qadi/core";

const clean = configOf(passwordAndRoles, { config: Roles.config([role({ name: "editor", permissions: [] })]) });

describe("the exit-code table (BEH-EA-225)", () => {
  it("every typed CLI error class carries its code as [Runtime.errorExitCode]", () => {
    const code = Runtime.getErrorExitCode;
    assert.strictEqual(code(new CliErrors.UsageError({ message: "x" })), 2);
    assert.strictEqual(code(new CliErrors.NotYetValidated({ source: "lucia", message: "x" })), 2);
    assert.strictEqual(code(new CliErrors.DoctorFindings({ count: 1, message: "x" })), 3);
    assert.strictEqual(code(new CliErrors.NothingToApply({ message: "x" })), 4);
    assert.strictEqual(code(new CliErrors.MigrationFailed({ message: "x" })), 5);
    assert.strictEqual(code(new CliErrors.ImportFailed({ runId: "r", message: "x" })), 5);
    assert.strictEqual(
      code(new CliErrors.ConfirmationRequired({ command: "import", message: "x" })),
      6,
    );
    assert.strictEqual(code(new CliErrors.LedgerDrift({ message: "x" })), 7);
    assert.strictEqual(code(new CliErrors.AuthenticationRequired({ message: "x" })), 8);
    for (const unavailable of [
      new CliErrors.ConfigUnavailable({ message: "x" }),
      new CliErrors.DatabaseUnavailable({ message: "x" }),
      new CliErrors.RolesNotInstalled({ message: "x" }),
      new CliErrors.LinkProblem({ code: "RouteConflict", message: "x" }),
      new CliErrors.ApplicationUnavailable({ message: "x" }),
    ]) {
      assert.strictEqual(code(unavailable), 9);
    }
  });

  it.effect("doctor on a clean configuration exits 0", () =>
    Effect.gen(function* () {
      const result = yield* runCli(["doctor"], clean);
      assert.strictEqual(result.code, 0);
      assert.isTrue(result.stdout.some((line) => line.includes("no findings")));
    }),
  );

  it.effect("doctor on an insecure composition exits 3 and --json carries the same tag and code", () =>
    Effect.gen(function* () {
      const text = yield* runCli(["doctor"], configOf(widgetOnly));
      assert.strictEqual(text.code, 3);
      assert.isTrue(text.stdout.some((line) => line.includes("csrf-missing")));
      const json = yield* runCli(["doctor", "--json"], configOf(widgetOnly));
      assert.strictEqual(json.code, 3);
      const failure: unknown = JSON.parse(json.stderr[0] ?? "null");
      assert.deepStrictEqual(failure, { _tag: "DoctorFindings", code: 3, message: "1 finding(s)" });
      const report: unknown = JSON.parse(json.stdout.join("\n"));
      assert.isTrue(typeof report === "object" && report !== null && "findings" in report);
    }),
  );

  it.effect("migration apply without --yes exits 6 and applies nothing", () =>
    Effect.gen(function* () {
      const result = yield* runCli(
        ["migration", "apply", "--database-url", "sqlite::memory:"],
        configOf(passwordAndRoles),
      );
      assert.strictEqual(result.code, 6);
      assert.isTrue(result.stdout.some((line) => line.includes("pending")));
    }),
  );

  it.effect("migration apply --dry-run exits 0, and --yes on a fresh database applies", () =>
    Effect.gen(function* () {
      const dry = yield* runCli(
        ["migration", "apply", "--dry-run", "--database-url", "sqlite::memory:"],
        configOf(passwordAndRoles),
      );
      assert.strictEqual(dry.code, 0);
      const applied = yield* runCli(
        ["migration", "apply", "--yes", "--database-url", "sqlite::memory:"],
        configOf(passwordAndRoles),
      );
      assert.strictEqual(applied.code, 0);
      assert.isTrue(applied.stdout.some((line) => line.startsWith("applied ")));
    }),
  );

  it.effect("a database-backed command with no database configured exits 9", () =>
    Effect.gen(function* () {
      const result = yield* runCli(["migration", "status"], configOf(passwordAndRoles));
      assert.strictEqual(result.code, 9);
      assert.isTrue(result.stderr.some((line) => line.includes("no database")));
    }),
  );

  it.effect("a missing configuration module exits 9", () =>
    Effect.gen(function* () {
      const result = yield* runCli(["routes"]);
      assert.strictEqual(result.code, 9);
    }),
  );
});

describe("Schema-bound arguments (BEH-EA-226)", () => {
  it.effect("seed admin --email not-an-email is a usage error before any service is built", () =>
    Effect.gen(function* () {
      // No `app` is provided: were the command to get as far as building services it would exit 9.
      const result = yield* runCli(["seed", "admin", "--email", "not-an-email"], configOf(passwordAndRoles));
      assert.strictEqual(result.code, 2);
    }),
  );

  it.effect("a malformed --database-url and an unknown --format are usage errors", () =>
    Effect.gen(function* () {
      const url = yield* runCli(["migration", "status", "--database-url", "mysql://x"], configOf(passwordAndRoles));
      assert.strictEqual(url.code, 2);
      const format = yield* runCli(["plugin", "list", "--format", "yaml"], configOf(passwordAndRoles));
      assert.strictEqual(format.code, 2);
    }),
  );

  it.effect("an unknown flag or command exits with the usage code; --help succeeds", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* runCli(["doctor", "--bogus"], clean)).code, 2);
      assert.strictEqual((yield* runCli(["frobnicate"], clean)).code, 2);
      assert.strictEqual((yield* runCli(["--help"], clean)).code, 0);
    }),
  );
});
