// @awthaq/cli — Doctor
//
// spec/behaviors/26-cli.md BEH-EA-201 (BE-003 sub-ticket D, ECS-005, ECS-008, ERS-008, NHS-005).
//
// `doctor` reports, as data:
//
//   1. plugin-graph linking problems — `Auth.make` throws a tagged link error while the
//      configuration module is evaluated (cycle, duplicate group id, route conflict), which the
//      loader hands over as a `LinkProblem`; and a `dependsOn` id no installed plugin has;
//   2. every configuration descriptor's audit (BEH-EA-229): the descriptors of the manifest, of
//      core (`EffectiveConfig.core`) and of the server (`BodyLimit.descriptor`), read against the
//      configuration Layer the module exports — built on its own, which needs no port and no
//      database (a Layer that is not exported audits the defaults);
//   3. a mutating endpoint with no `CsrfProtection`, walked off the composed contract;
//   4. with `--build` only (a database-backed command, BEH-EA-208): the application Layer built
//      once in a scope that closes straight away — an unprovided port or a malformed `Config`
//      value becomes a finding instead of a crash at first boot — and the built services checked
//      for a development mailer or a permissive rate limiter in production (NHS-005).
//
// It never prints the value of a `Redacted` or declared-sensitive input (ECS-005): every message
// below is built from names and counts, the descriptors render values as `<redacted>` (and scrub a
// connection string's password), and a build failure is reported by its error's name, never its
// message — a `Config` error can quote the value it rejected.
//
// Severities: an `error` or `warning` is a finding and ends the run with `DoctorFindings`
// (exit 3, BEH-EA-225); an `info` is a note, printed but not counted (a relaxed `SameSite` is
// a note in development and a warning in production).

import { EffectiveConfig } from "@awthaq/core";
import type { ConfigDescriptor } from "@awthaq/core";
import { Mailer, RateLimiter } from "@awthaq/ports";
import { BodyLimit } from "@awthaq/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ApplicationUnavailable,
  ConfigUnavailable,
  DoctorFindings,
  type LinkProblem,
} from "./CliErrors.ts";
import type { CliConfig } from "./Config.ts";
import * as Output from "./Output.ts";
import * as Routes from "./Routes.ts";

/** One line of the report; `owner` is a plugin id, `core`, `server`, `graph` or `build`. */
export interface Finding extends ConfigDescriptor.Finding {
  readonly owner: string;
}

export interface Report {
  readonly environment: "production" | "development";
  readonly build: boolean;
  /** Errors and warnings: what ends the run with exit code 3. */
  readonly findings: ReadonlyArray<Finding>;
  /** `info` severity: printed, not counted. */
  readonly notes: ReadonlyArray<Finding>;
}

export interface Options {
  /** `--build`: also build the application Layer once and audit the services it provides. */
  readonly build: boolean;
  readonly production: boolean;
}

const finding = (
  owner: string,
  severity: ConfigDescriptor.Severity,
  code: string,
  message: string,
): Finding => ({ owner, severity, code, message });

const split = (all: ReadonlyArray<Finding>) => ({
  findings: all.filter((found) => found.severity !== "info"),
  notes: all.filter((found) => found.severity === "info"),
});

const reportOf = (options: Options, all: ReadonlyArray<Finding>): Report => ({
  environment: options.production ? "production" : "development",
  build: options.build,
  ...split(all),
});

/** `Auth.make` refused the composition while the configuration module was evaluated. */
export const linkFailure = (problem: LinkProblem, options: Options): Report =>
  reportOf(options, [finding("graph", "error", `link-${problem.code}`, problem.message)]);

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The manifest checks: a declared dependency nobody installed, and CSRF coverage of the contract. */
const graphFindings = (config: CliConfig) =>
  Effect.gen(function* () {
    const installed = new Set(config.auth.manifest.plugins.map((plugin) => plugin.id));
    const missing = config.auth.manifest.plugins.flatMap((plugin) =>
      plugin.dependsOn
        .filter((dep) => !installed.has(dep))
        .map((dep) =>
          finding(
            plugin.id,
            "error",
            "missing-dependency",
            `plugin "${plugin.id}" depends on plugin "${dep}", which is not installed`,
          ),
        ),
    );
    const routes = yield* Routes.routesOf(config.auth);
    const unprotected = routes
      .filter((route) => MUTATING.has(route.method) && !route.middleware.includes("CsrfProtection"))
      .map((route) =>
        finding(
          route.plugin ?? route.group,
          "warning",
          "csrf-missing",
          `${route.method} ${route.path} has no CsrfProtection middleware`,
        ),
      );
    return [...missing, ...unprotected];
  });

/** Every descriptor the CLI can see: the manifest's, core's and the server's. */
export const descriptorsOf = (config: CliConfig): ReadonlyArray<EffectiveConfig.Owned> => [
  ...config.auth.manifest.config.map(({ pluginId, descriptor }) => ({
    owner: pluginId,
    descriptor,
  })),
  ...EffectiveConfig.core,
  ...EffectiveConfig.owned("server", [BodyLimit.descriptor]),
];

/**
 * The configuration Layer's `Context`, built on its own (ADR-EA-006 revision 1.2): a Layer with
 * no requirements sets values and nothing else, so reading a reference back yields what it
 * sets, and a reference it never provided reads back as its default.
 */
export const configContext = Effect.fnUntraced(function* (config: CliConfig) {
  if (config.config === undefined) return Context.empty();
  return yield* Layer.build(config.config).pipe(
    Effect.scoped,
    Effect.mapError(
      () =>
        new ConfigUnavailable({
          message:
            "the configuration Layer exported by the configuration module failed to build on its own",
        }),
    ),
  );
});

/** A failure named, never quoted: a `Config` error can carry the value it rejected. */
const nameOf = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : error instanceof Error
      ? error.name
      : "an unknown failure";

/** `--build`: builds the application Layer once, in a scope that closes straight away. */
const buildFindings = (config: CliConfig, options: Options) =>
  Effect.gen(function* () {
    if (config.app === undefined) {
      return yield* new ApplicationUnavailable({
        message:
          "doctor --build needs the application Layer: export `app` (auth.layer with every port and the SQL client provided) from the configuration module",
      });
    }
    const built = yield* Effect.exit(Layer.build(config.app).pipe(Effect.scoped));
    if (built._tag === "Failure") {
      const reason = built.cause.reasons.find((r) => r._tag === "Fail");
      return {
        findings: [
          finding(
            "build",
            "error",
            "app-build-failed",
            `the application Layer failed to build (${nameOf(reason?._tag === "Fail" ? reason.error : undefined)}); build it directly to read the details, doctor withholds them because a configuration error can quote a secret`,
          ),
        ],
        context: undefined,
      };
    }
    const context = built.value;
    const severity = options.production ? "error" : "info";
    const found: Array<Finding> = [];
    const mailer = Context.getOption(context, Mailer.Mailer);
    if (mailer._tag === "Some" && mailer.value.development === true) {
      found.push(
        finding(
          "build",
          severity,
          "mailer-development",
          "the Mailer is a development implementation (layerNoop or layerMemory): verification and reset mail is dropped or kept in memory",
        ),
      );
    }
    const limiter = Context.getOption(context, RateLimiter.RateLimiter);
    if (limiter._tag === "Some" && limiter.value.permissive === true) {
      found.push(
        finding(
          "build",
          severity,
          "rate-limiter-permissive",
          "the RateLimiter is RateLimiter.layerPermissive, which disables every rate-limit rule (NHS-005)",
        ),
      );
    }
    return { findings: found, context };
  });

/** Runs every check that applies and returns the report; the caller prints it and decides the exit. */
export const diagnose = (config: CliConfig, options: Options) =>
  Effect.gen(function* () {
    const environment = { production: options.production };
    const all: Array<Finding> = [...(yield* graphFindings(config))];
    const configured = yield* configContext(config).pipe(
      Effect.map((context) => ({ context, failed: false })),
      Effect.catchTag("ConfigUnavailable", () =>
        Effect.succeed({ context: Context.empty(), failed: true }),
      ),
    );
    if (configured.failed) {
      all.push(
        finding(
          "config",
          "error",
          "config-layer-failed",
          "the configuration Layer exported by the configuration module failed to build on its own",
        ),
      );
    }
    let audited = configured.context;
    if (options.build) {
      const built = yield* buildFindings(config, options);
      all.push(...built.findings);
      if (built.context !== undefined) audited = built.context;
    }
    const descriptors = descriptorsOf(config);
    all.push(
      ...EffectiveConfig.audit(audited, descriptors, environment).map((found) =>
        finding(found.owner, found.severity, found.code, found.message),
      ),
    );
    return reportOf(options, all);
  });

const label = (found: Finding) => `${found.severity.padEnd(7)} [${found.code}] (${found.owner}) ${found.message}`;

export const renderText = (report: Report) => [
  `awthaq doctor (${report.environment}${report.build ? ", --build" : ""})`,
  ...report.findings.map(label),
  ...report.notes.map(label),
  report.findings.length === 0
    ? `no findings${report.notes.length === 0 ? "" : ` (${report.notes.length} note(s))`}`
    : `${report.findings.length} finding(s)`,
];

/** Prints the report; fails `DoctorFindings` (exit 3) when it holds a finding, `--json` document included. */
export const finish = (report: Report) =>
  Effect.gen(function* () {
    yield* Output.report(report, renderText);
    if (report.findings.length > 0) {
      return yield* new DoctorFindings({
        count: report.findings.length,
        message: `${report.findings.length} finding(s)`,
      });
    }
  });
