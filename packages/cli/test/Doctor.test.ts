// BEH-EA-201 (ECS-005, ECS-008, NHS-005): `doctor` over real compositions. Each finding here is
// produced by the real thing — a real `Auth.make`, a real configuration Layer, a real application
// Layer — and every output is checked for the canary secrets the fixtures carry.
import { SessionCookie } from "@awthaq/core";
import { Mailer, RateLimiter } from "@awthaq/ports";
import { Roles } from "@awthaq/roles";
import { BodyLimit } from "@awthaq/server";
import { assert, describe, it } from "@effect/vitest";
import * as ByteSize from "effect/ByteSize";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Runtime from "effect/Runtime";
import { role } from "@qadi/core";
import { LinkProblem } from "../src/CliErrors.ts";
import * as ConfigList from "../src/ConfigList.ts";
import * as Doctor from "../src/Doctor.ts";
import * as Output from "../src/Output.ts";
import { configOf, passwordAndRoles } from "./support/TestApp.ts";
import { WidgetConfig, widgetOnly } from "./support/WidgetPlugin.ts";

class BuildFailure extends Data.TaggedError("BuildFailure")<{ readonly message: string }> {}

const CANARIES = ["sk-canary-123", "hunter2-canary", "canary-signing-key"];

const development = { build: false, production: false };
const production = { build: false, production: true };

const editor = role({ name: "editor", permissions: [] });
/** A configuration Layer that leaves nothing for doctor to complain about. */
const goodConfig = Roles.config([editor]);

const secretConfig = Layer.succeed(WidgetConfig, {
  minLength: 12,
  clientSecret: "sk-canary-123",
  signingKey: Redacted.make("canary-signing-key"),
  databaseUrl: "postgres://app:hunter2-canary@db.internal/app",
});

const codes = (report: Doctor.Report) => report.findings.map((found) => found.code);

const exitCode = <A, E>(exit: Exit.Exit<A, E>) => {
  if (!Exit.isFailure(exit)) return 0;
  const error = Exit.findErrorOption(exit);
  return error._tag === "Some" ? Runtime.getErrorExitCode(error.value) : -1;
};

const finishOutput = (report: Doctor.Report, json: boolean) =>
  Effect.gen(function* () {
    const { captured, layer } = yield* Output.capture(json);
    const exit = yield* Effect.exit(Doctor.finish(report).pipe(Effect.provide(layer)));
    const lines = [...(yield* Ref.get(captured.stdout)), ...(yield* Ref.get(captured.stderr))];
    return { exit, text: lines.join("\n") };
  });

describe("doctor: graph", () => {
  it.effect("reports a declared dependency no installed plugin provides", () =>
    Effect.gen(function* () {
      const manifest = {
        plugins: [
          { id: "billing", apiVersion: 1 as const, tables: [], dependsOn: ["ledger"], groups: [] },
        ],
        config: [],
        hooks: {},
      };
      const config = configOf({ ...passwordAndRoles, manifest });
      const report = yield* Doctor.diagnose(config, development);
      assert.include(codes(report), "missing-dependency");
      assert.strictEqual(
        report.findings.find((found) => found.code === "missing-dependency")?.owner,
        "billing",
      );
    }),
  );

  it.effect("reports an Auth.make link failure as a finding instead of crashing", () =>
    Effect.gen(function* () {
      const report = Doctor.linkFailure(
        new LinkProblem({ code: "RouteConflict", message: "E_ROUTE_CONFLICT: POST /x twice" }),
        development,
      );
      assert.deepStrictEqual(codes(report), ["link-RouteConflict"]);
      const { exit } = yield* finishOutput(report, false);
      assert.strictEqual(exitCode(exit), 3);
    }),
  );

  it.effect("flags a mutating endpoint that carries no CsrfProtection", () =>
    Effect.gen(function* () {
      const report = yield* Doctor.diagnose(configOf(widgetOnly), development);
      const csrf = report.findings.filter((found) => found.code === "csrf-missing");
      assert.deepStrictEqual(
        csrf.map((found) => found.message),
        ["POST /widget has no CsrfProtection middleware"],
      );
    }),
  );
});

describe("doctor: configuration audits", () => {
  it.effect("is clean for a composition whose defaults and configuration are sound", () =>
    Effect.gen(function* () {
      const report = yield* Doctor.diagnose(
        configOf(passwordAndRoles, { config: goodConfig }),
        production,
      );
      assert.deepStrictEqual(codes(report), []);
      const { exit } = yield* finishOutput(report, false);
      assert.strictEqual(exitCode(exit), 0);
    }),
  );

  it.effect("audits the defaults when the module exports no configuration Layer", () =>
    Effect.gen(function* () {
      const report = yield* Doctor.diagnose(configOf(passwordAndRoles), production);
      // The Roles catalog default is empty: a plugin installed without `Roles.config([...])`.
      assert.include(codes(report), "roles-empty-catalog");
    }),
  );

  it.effect("flags a relaxed SameSite as a warning in production and a note in development", () =>
    Effect.gen(function* () {
      const lax = configOf(passwordAndRoles, {
        config: Layer.mergeAll(
          goodConfig,
          SessionCookie.config({
            mode: SessionCookie.SecureDomain({ domain: "acme.com", sameSite: "lax" }),
          }),
        ),
      });
      const prod = yield* Doctor.diagnose(lax, production);
      assert.deepStrictEqual(codes(prod), ["cookie-samesite-relaxed"]);
      const dev = yield* Doctor.diagnose(lax, development);
      assert.deepStrictEqual(codes(dev), []);
      assert.deepStrictEqual(
        dev.notes.map((note) => note.code),
        ["cookie-samesite-relaxed"],
      );
    }),
  );

  it.effect("flags an oversized body limit", () =>
    Effect.gen(function* () {
      const report = yield* Doctor.diagnose(
        configOf(passwordAndRoles, {
          config: Layer.mergeAll(goodConfig, BodyLimit.config({ maxBytes: ByteSize.mebibytes(64) })),
        }),
        production,
      );
      assert.deepStrictEqual(codes(report), ["body-limit-large"]);
    }),
  );

  it.effect("reports a configuration Layer that fails to build", () =>
    Effect.gen(function* () {
      const failing = Layer.effectDiscard(Effect.fail("boom-canary-value"));
      const report = yield* Doctor.diagnose(
        configOf(passwordAndRoles, { config: failing }),
        development,
      );
      assert.include(codes(report), "config-layer-failed");
    }),
  );
});

describe("doctor: no secret values (ECS-005)", () => {
  it.effect("prints neither the secrets nor the connection password, in text or JSON", () =>
    Effect.gen(function* () {
      const config = configOf(widgetOnly, { config: secretConfig });
      const report = yield* Doctor.diagnose(config, production);
      for (const json of [false, true]) {
        const { text } = yield* finishOutput(report, json);
        for (const canary of CANARIES) assert.notInclude(text, canary);
      }
      const listed = yield* Output.capture(false);
      yield* ConfigList.show(config).pipe(Effect.provide(listed.layer));
      const text = (yield* Ref.get(listed.captured.stdout)).join("\n");
      for (const canary of CANARIES) assert.notInclude(text, canary);
      assert.include(text, "clientSecret = <redacted>");
      assert.include(text, "signingKey = <redacted>");
      assert.include(text, "databaseUrl = postgres://app:<redacted>@db.internal/app");
      assert.include(text, "test/cli/WidgetConfig  (override)");
    }),
  );
});

describe("doctor --build", () => {
  // `--build` audits the values of the application's own context, so the app carries the configuration.
  const app = (extra: Layer.Layer<Mailer.Mailer | RateLimiter.RateLimiter>) =>
    Layer.mergeAll(goodConfig, extra);

  it.effect("flags a development mailer and a permissive rate limiter in production", () =>
    Effect.gen(function* () {
      const config = configOf(passwordAndRoles, {
        config: goodConfig,
        app: app(Layer.mergeAll(Mailer.layerMemory, RateLimiter.layerPermissive)),
      });
      const report = yield* Doctor.diagnose(config, { build: true, production: true });
      assert.deepStrictEqual(codes(report).sort(), ["mailer-development", "rate-limiter-permissive"]);
      const dev = yield* Doctor.diagnose(config, { build: true, production: false });
      assert.deepStrictEqual(codes(dev), []);
    }),
  );

  it.effect("reports an application Layer that fails to build without quoting the failure", () =>
    Effect.gen(function* () {
      const failing = Layer.effectDiscard(
        Effect.fail(new BuildFailure({ message: "bad value sk-canary-123 in AWTHAQ_CSRF_SECRET" })),
      );
      const report = yield* Doctor.diagnose(
        configOf(passwordAndRoles, { config: goodConfig, app: failing }),
        { build: true, production: false },
      );
      assert.deepStrictEqual(codes(report), ["app-build-failed"]);
      const { text } = yield* finishOutput(report, false);
      assert.notInclude(text, "sk-canary-123");
    }),
  );

  it.effect("fails ApplicationUnavailable (exit 9) when the module exports no application Layer", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Doctor.diagnose(configOf(passwordAndRoles, { config: goodConfig }), {
          build: true,
          production: false,
        }),
      );
      assert.strictEqual(exitCode(exit), 9);
    }),
  );
});
