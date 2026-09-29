// @awthaq/cli — Cli
//
// ADR-EA-027: the command tree, declared with `effect/unstable/cli`. This file is only
// *declaration and wiring*: every command body is a plain Effect function in its own module
// (`Doctor.ts`, `Routes.ts`, `Migration.ts`, ...), taking typed arguments. That seam is what
// isolates the release-candidate churn of the unstable CLI API — when `Command`/`Flag` change, only
// the thin declarations here do — and it is what the tests call directly.
//
//   awthaq [--config <path>] [--json]
//     doctor [--build] [--production]
//     config list
//     plugin list [--graph | --hooks | --rules] [--format text|json|dot]
//     routes
//     openapi [--out <file>]
//     migration status | apply [--yes] [--dry-run] [--allow-empty]      (--database-url)
//     seed admin --email <email> [--name] [--role] [--force] [--prompt-password]
//     import --from <source> --source <export> [--yes] [--dry-run] [--continue-on-error]
//            [--batch-size] [--report <file>] [--issuer p=i] [--source-option k=v]
//     login [--token <t>] [--base-url <url>] [--no-browser] [--client-id <id>] | logout | whoami
//                                                                                  (AWTHAQ_TOKEN, AWTHAQ_BASE_URL)
//
// Every flag decodes through a Schema (BEH-EA-226): the email through the sign-up payload's own
// Schema, `--database-url` through `Database.DatabaseUrl`, `--format` through a literal union.
// A parser or Schema failure is remapped to the usage error (exit 2) by `run`, so a mistyped flag
// and a refused write never share a status (BEH-EA-225).

import { EmailContract } from "@awthaq/api";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as CliError from "effect/unstable/cli/CliError";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as Prompt from "effect/unstable/cli/Prompt";
import type * as CliErrors from "./CliErrors.ts";
import { isCliError, UsageError } from "./CliErrors.ts";
import * as CliConfig from "./Config.ts";
import * as ConfigList from "./ConfigList.ts";
import * as Database from "./Database.ts";
import * as Doctor from "./Doctor.ts";
import * as Import from "./Import.ts";
import * as Migration from "./Migration.ts";
import * as Openapi from "./Openapi.ts";
import * as Output from "./Output.ts";
import * as Plugin from "./Plugin.ts";
import * as Routes from "./Routes.ts";
import * as Seed from "./Seed.ts";
import * as Session from "./Session.ts";
import * as Sources from "./Sources.ts";

export const version = "0.1.0";

// ---- shared flags ----------------------------------------------------------

const configFlag = Flag.String("config").pipe(
  Flag.withDescription("Path to the configuration module (default: ./awthaq.config.ts)"),
  Flag.optional,
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print results (and failures) as JSON documents"),
  Flag.withDefault(false),
);

/** BEH-EA-226: a connection string, decoded before any connection is attempted; the environment variable is the safe way to pass one. */
const databaseUrlFlag = Flag.String("database-url").pipe(
  Flag.withSchema(Database.DatabaseUrl),
  Flag.withDescription(
    "sqlite:<path> | postgres://… (or AWTHAQ_DATABASE_URL); default: the configuration module's `sql`",
  ),
  Flag.withFallbackConfig(Config.String("AWTHAQ_DATABASE_URL")),
  Flag.optional,
);

export const root = Command.make("awthaq").pipe(
  Command.withDescription(
    "Inspect and operate an awthaq authentication runtime. Reads the plugin manifest; never serves the application.",
  ),
  Command.withSharedFlags({ config: configFlag, json: jsonFlag }),
);

/** Loads the configuration module named by `--config` (or the default) through the `ConfigSource` service. */
const load = Effect.gen(function* () {
  const shared = yield* root;
  const source = yield* CliConfig.ConfigSource;
  return yield* source.load(Option.getOrUndefined(shared.config));
});

/** Runs `body` with `Output` bound to the `--json` flag. */
const withOutput = <A, E, R>(body: Effect.Effect<A, E, R | Output.Output>) =>
  Effect.gen(function* () {
    const shared = yield* root;
    return yield* body.pipe(Effect.provide(Output.layerConsole(shared.json)));
  });

// ---- inspection commands (BEH-EA-208, class 1) -----------------------------

const isProduction = (flag: boolean, configured: boolean | undefined) =>
  Effect.gen(function* () {
    if (flag) return true;
    if (configured !== undefined) return configured;
    const nodeEnv = yield* Config.String("NODE_ENV").pipe(Config.withDefault(""));
    return nodeEnv === "production";
  });

const doctor = Command.make(
  "doctor",
  {
    build: Flag.Boolean("build").pipe(
      Flag.withDescription(
        "Also build the application Layer once (never serving it) and audit what it provides",
      ),
      Flag.withDefault(false),
    ),
    production: Flag.Boolean("production").pipe(
      Flag.withDescription(
        "Audit as a production environment (default: the module's `production`, then NODE_ENV)",
      ),
      Flag.withDefault(false),
    ),
  },
  (args) =>
    withOutput(
      load.pipe(
        Effect.flatMap((config) =>
          isProduction(args.production, config.production).pipe(
            Effect.flatMap((production) =>
              Doctor.diagnose(config, { build: args.build, production }),
            ),
          ),
        ),
        // `Auth.make` refused the composition while the module was evaluated: that is the finding.
        Effect.catchTag("LinkProblem", (problem) =>
          isProduction(args.production, undefined).pipe(
            Effect.map((production) =>
              Doctor.linkFailure(problem, { build: args.build, production }),
            ),
          ),
        ),
        Effect.flatMap(Doctor.finish),
      ),
    ),
).pipe(
  Command.withDescription(
    "Report plugin-graph problems, configuration audits and insecure defaults (exit 3 when it finds any)",
  ),
);

const configList = Command.make("list", {}, () =>
  withOutput(load.pipe(Effect.flatMap(ConfigList.show))),
).pipe(
  Command.withDescription(
    "List every declared configuration input, its default and its override (secrets redacted)",
  ),
);

const configCommand = Command.make("config").pipe(
  Command.withDescription("Inspect configuration"),
  Command.withSubcommands([configList]),
);

const pluginList = Command.make(
  "list",
  {
    graph: Flag.Boolean("graph").pipe(
      Flag.withDescription(
        "Print dependency edges, groups, tables, required ports and hook-tap positions",
      ),
      Flag.withDefault(false),
    ),
    hooks: Flag.Boolean("hooks").pipe(
      Flag.withDescription("Print each hook point's declared taps in the order they run"),
      Flag.withDefault(false),
    ),
    rules: Flag.Boolean("rules").pipe(
      Flag.withDescription("Print every plugin's declared rate-limit rules (the defaults)"),
      Flag.withDefault(false),
    ),
    format: Flag.Literals("format", ["text", "json", "dot"]).pipe(
      Flag.withDescription("text | json | dot"),
      Flag.withDefault("text"),
    ),
  },
  (args) =>
    withOutput(
      load.pipe(
        Effect.flatMap((config) =>
          Plugin.show(config.auth, {
            graph: args.graph,
            hooks: args.hooks,
            rules: args.rules,
            format: args.format,
          }),
        ),
      ),
    ),
).pipe(Command.withDescription("List installed plugins in the linker's order"));

const pluginCommand = Command.make("plugin").pipe(
  Command.withDescription("Inspect the plugin graph"),
  Command.withSubcommands([pluginList]),
);

const routes = Command.make("routes", {}, () =>
  withOutput(load.pipe(Effect.flatMap((config) => Routes.show(config.auth)))),
).pipe(Command.withDescription("List every endpoint with its owning plugin and middleware"));

const openapi = Command.make(
  "openapi",
  {
    out: Flag.String("out").pipe(
      Flag.withDescription("Write the document to this file instead of stdout"),
      Flag.optional,
    ),
  },
  (args) =>
    withOutput(
      load.pipe(
        Effect.flatMap((config) =>
          Openapi.emit(config.auth, { out: Option.getOrUndefined(args.out) }),
        ),
      ),
    ),
).pipe(Command.withDescription("Emit the aggregated OpenAPI document"));

// ---- database-backed commands (BEH-EA-208, class 2) ------------------------

const migrationStatus = Command.make("status", { databaseUrl: databaseUrlFlag }, (args) =>
  withOutput(
    load.pipe(
      Effect.flatMap((config) =>
        Migration.status(config.auth).pipe(
          Effect.provide(Database.layerFrom(config, Option.getOrUndefined(args.databaseUrl))),
        ),
      ),
    ),
  ),
).pipe(
  Command.withDescription(
    "Report applied and pending migrations against both ledgers (exit 7 on drift)",
  ),
);

const migrationApply = Command.make(
  "apply",
  {
    databaseUrl: databaseUrlFlag,
    yes: Flag.Boolean("yes").pipe(
      Flag.withDescription("Confirm: without it nothing is applied"),
      Flag.withDefault(false),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the plan and apply nothing"),
      Flag.withDefault(false),
    ),
    allowEmpty: Flag.Boolean("allow-empty").pipe(
      Flag.withDescription("Exit 0 (not 4) when nothing is pending"),
      Flag.withDefault(false),
    ),
  },
  (args) =>
    withOutput(
      load.pipe(
        Effect.flatMap((config) =>
          Migration.apply(config.auth, {
            yes: args.yes,
            dryRun: args.dryRun,
            allowEmpty: args.allowEmpty,
          }).pipe(
            Effect.provide(Database.layerFrom(config, Option.getOrUndefined(args.databaseUrl))),
          ),
        ),
      ),
    ),
).pipe(
  Command.withDescription(
    "Print the ordered pending plan, refuse on drift, apply with --yes (core first, then plugins)",
  ),
);

const migrationCommand = Command.make("migration").pipe(
  Command.withDescription("Read and advance the migration ledgers"),
  Command.withSubcommands([migrationStatus, migrationApply]),
);

const passwordFromEnv = Config.Redacted("AWTHAQ_SEED_ADMIN_PASSWORD").pipe(Config.option);

const seedAdmin = Command.make(
  "admin",
  {
    email: Flag.String("email").pipe(
      Flag.withSchema(EmailContract.Email),
      Flag.withDescription("The administrator's email (validated like the sign-up payload's)"),
    ),
    name: Flag.String("name").pipe(
      Flag.withDescription(
        "Display name for a newly created account (default: the email's local part)",
      ),
      Flag.optional,
    ),
    role: Flag.String("role").pipe(
      Flag.withDescription("The administrative role to grant"),
      Flag.withDefault(Seed.DEFAULT_ADMIN_ROLE),
    ),
    force: Flag.Boolean("force").pipe(
      Flag.withDescription("Grant even though an administrator already exists"),
      Flag.withDefault(false),
    ),
    promptPassword: Flag.Boolean("prompt-password").pipe(
      Flag.withDescription(
        "Prompt for a password credential (or set AWTHAQ_SEED_ADMIN_PASSWORD); never pass one on argv",
      ),
      Flag.withDefault(false),
    ),
  },
  (args) =>
    withOutput(
      Effect.gen(function* () {
        const config = yield* load;
        const fromEnv = yield* passwordFromEnv;
        const password = args.promptPassword
          ? Option.some(
              Redacted.make(
                yield* Prompt.run(Prompt.Password({ message: "Administrator password" })).pipe(
                  Effect.map(Redacted.value),
                  Effect.mapError(() => new UsageError({ message: "no password was entered" })),
                ),
              ),
            )
          : fromEnv;
        yield* Seed.seedAdmin(config, {
          email: args.email,
          name: Option.getOrElse(args.name, () => args.email.split("@")[0] ?? args.email),
          role: args.role,
          force: args.force,
          password,
        });
      }),
    ),
).pipe(
  Command.withDescription("Create or promote the first administrator through Users and Roles"),
);

const seedCommand = Command.make("seed").pipe(
  Command.withDescription("Provision data through the domain services"),
  Command.withSubcommands([seedAdmin]),
);

// ---- session commands (BEH-EA-208, class 3): outbound clients of a running server ----------

const loginCommand = Command.make(
  "login",
  {
    token: Flag.Redacted("token").pipe(
      Flag.withDescription(
        "A session token or service token (prefer AWTHAQ_TOKEN: argv shows in process listings)",
      ),
      Flag.withFallbackConfig(Config.Redacted("AWTHAQ_TOKEN")),
      Flag.optional,
    ),
    baseUrl: Flag.String("base-url").pipe(
      Flag.withSchema(Session.BaseUrl),
      Flag.withDescription("The auth server (or AWTHAQ_BASE_URL)"),
      Flag.withFallbackConfig(Config.String("AWTHAQ_BASE_URL")),
      Flag.optional,
    ),
    noBrowser: Flag.Boolean("no-browser").pipe(
      Flag.withDescription(
        "Interactive login: print the verification URL and code instead of opening a browser",
      ),
      Flag.withDefault(false),
    ),
    clientId: Flag.String("client-id").pipe(
      Flag.withDescription(
        "Interactive login: the device-flow client the server registered for this CLI",
      ),
      Flag.withDefault("awthaq-cli"),
    ),
  },
  (args) =>
    withOutput(
      Session.login({
        token: args.token,
        baseUrl: args.baseUrl,
        noBrowser: args.noBrowser,
        clientId: args.clientId,
      }),
    ),
).pipe(
  Command.withDescription(
    "Sign in: with --token (or AWTHAQ_TOKEN) validate a token and store it; without one, run the device authorization flow (a code to approve in a browser) — stored in the OS keychain first, else a 0600 file",
  ),
);

const logoutCommand = Command.make("logout", {}, () => withOutput(Session.logout)).pipe(
  Command.withDescription(
    "Clear the stored credential and revoke the session server-side (best effort)",
  ),
);

const whoamiCommand = Command.make("whoami", {}, () => withOutput(Session.whoami)).pipe(
  Command.withDescription(
    "Print who the stored credential resolves to (exit 8 when not logged in)",
  ),
);

const importCommand = Command.make(
  "import",
  {
    from: Flag.Literals("from", Sources.sourceNames).pipe(
      Flag.withDescription(
        `The source framework: ${Sources.sourceNames.join(" | ")} (authjs and lucia are registered but not yet validated)`,
      ),
    ),
    source: Flag.String("source").pipe(
      Flag.withDescription(
        "The export: sqlite:<path> | postgres://… (better-auth), the users.json path (firebase)",
      ),
    ),
    sourceOption: Flag.KeyValuePair("source-option").pipe(
      Flag.withDescription("Adapter input, key=value (firebase: hash-config=<hash_config.json>)"),
      Flag.withDefault({}),
    ),
    issuer: Flag.KeyValuePair("issuer").pipe(
      Flag.withDescription(
        "OAuth issuer per provider id, provider=issuer (the value your OAuth provider config sets)",
      ),
      Flag.withDefault({}),
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withDescription("Confirm: without it `import` only prints the plan and writes nothing"),
      Flag.withDefault(false),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Plan only, even with --yes"),
      Flag.withDefault(false),
    ),
    continueOnError: Flag.Boolean("continue-on-error").pipe(
      Flag.withDescription("Keep going after a failed (rolled-back) batch"),
      Flag.withDefault(false),
    ),
    batchSize: Flag.Int("batch-size").pipe(
      Flag.withSchema(Import.BatchSize),
      Flag.withDescription("Users per transaction (default 100)"),
      Flag.withDefault(100),
    ),
    report: Flag.String("report").pipe(
      Flag.withDescription(
        "Write the per-row report (unmapped fields, unmappable rows, failures) to this JSON file",
      ),
      Flag.optional,
    ),
  },
  (args) =>
    withOutput(
      load.pipe(
        Effect.flatMap((config) =>
          Import.importUsers(config, {
            from: args.from,
            source: {
              location: args.source,
              options: args.sourceOption,
              issuers: args.issuer,
              batchSize: args.batchSize,
            },
            yes: args.yes,
            dryRun: args.dryRun,
            continueOnError: args.continueOnError,
            report: Option.getOrUndefined(args.report),
          }),
        ),
      ),
    ),
).pipe(
  Command.withDescription(
    "Import users from another auth framework through Users/Accounts: plan by default, --yes to write (checkpointed, resumable)",
  ),
);

// ---- the tree ---------------------------------------------------------------

export const cli = root.pipe(
  Command.withSubcommands([
    doctor,
    configCommand,
    pluginCommand,
    routes,
    openapi,
    migrationCommand,
    seedCommand,
    importCommand,
    loginCommand,
    logoutCommand,
    whoamiCommand,
  ]),
);

// ---- running ---------------------------------------------------------------

const messageOf = (error: CliError.CliError) =>
  error._tag === "ShowHelp" && error.errors.length > 0
    ? "invalid usage: see the message and help above"
    : "invalid usage";

/**
 * Runs the tree against `args` and maps every failure to its typed exit code (BEH-EA-225): a CLI
 * error is rendered on stderr (a JSON document under `--json`) and re-failed so the entry point's
 * `runMain` ends the process with the code the class carries; the framework's own `CliError`
 * (a mistyped flag, an unknown command) becomes the usage error, except a plain help request,
 * which succeeds.
 */
export const run = (args: ReadonlyArray<string>) => {
  const json = args.includes("--json");
  const failWith = (error: CliErrors.CliError) =>
    Output.failure(error).pipe(
      Effect.provide(Output.layerConsole(json)),
      Effect.andThen(Effect.fail(error)),
    );
  return Command.runWith(cli, { version })(args).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (error) {
        if (isCliError(error)) return yield* failWith(error);
        if (CliError.isCliError(error)) {
          if (error._tag === "ShowHelp" && error.errors.length === 0) return;
          return yield* failWith(new UsageError({ message: messageOf(error) }));
        }
        return yield* Effect.fail(error);
      }),
    ),
    // stdout is the command's data (`--json` is parsed from it); a core service's warning (a store
    // outage, `MA-004`) is a log line and belongs on stderr.
    Effect.provideService(Logger.LogToStderr, true),
  );
};
