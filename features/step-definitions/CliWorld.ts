// BEH-EA-201..208, 225..229 (26-cli.feature): the real `awthaq` command tree, run in-process.
//
// Every scenario runs `Cli.run(argv)` — the same entry the binary calls — against a composition the
// Scenario sets up (`Auth.make([...])` over shipped plugins, never a fake manifest), with the
// process's console captured and the exit status read off the typed failure exactly as the binary
// maps it (`Runtime.getErrorExitCode`, BEH-EA-225). Database-backed commands run over a real
// in-memory SQLite client the *World* owns, so state survives across the separate runtimes each
// invocation builds, the way a database does (the same seam `packages/cli/test/support/*` uses).
import {
  Browser,
  Cli,
  CliErrors,
  Config as CliConfigModule,
  CredentialStore,
  DeviceLogin,
} from "@awthaq/cli";
import {
  Accounts,
  Auth,
  AuditLog,
  AuthEvents,
  AuthPlugin,
  ConfigDescriptor,
  DataExport,
  Erasure,
  Hooks,
  Migrations,
  Slots,
  Users,
} from "@awthaq/core";
import { Encryption, KeyProvider, SqlTransaction } from "@awthaq/ports";
import { Password } from "@awthaq/password";
import { Roles } from "@awthaq/roles";
import { CoreMigrations, Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { role } from "@qadi/core";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Runtime from "effect/Runtime";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { cheapArgon2id } from "./shared/Harness.ts";
import { makeOutcomes, type Outcomes } from "./shared/Outcomes.ts";
import { startSessionServer, type SessionServer } from "./SessionServer.ts";

// ---- the compositions ---------------------------------------------------------------------

/** Password + Roles: HTTP groups (`password`, `password.account`) and the roles table. */
export const passwordAndRoles = Auth.make([Password.Password, Roles.Roles]);

export const configOf = (
  auth: CliConfigModule.LoadedAuth,
  extra?: Partial<Omit<CliConfigModule.CliConfig, "auth">>,
): CliConfigModule.CliConfig => ({
  auth,
  config: undefined,
  sql: undefined,
  app: undefined,
  production: undefined,
  ...extra,
});

export interface WidgetConfigShape {
  readonly minLength: number;
  readonly clientSecret: string;
  readonly signingKey: Redacted.Redacted<string>;
  readonly databaseUrl: string;
}

export const WidgetConfig = Context.Reference<WidgetConfigShape>("features/cli/WidgetConfig", {
  defaultValue: () => ({
    minLength: 12,
    clientSecret: "sk-default-secret",
    signingKey: Redacted.make("default-signing-key"),
    databaseUrl: "postgres://app:default-password@db.internal/app",
  }),
});

const WidgetApi = HttpApi.make("auth").add(
  HttpApiGroup.make("widget")
    // A mutating endpoint with no CsrfProtection: the "csrf disabled" insecure default.
    .add(HttpApiEndpoint.post("create", "/widget", { success: Schema.String }))
    .add(HttpApiEndpoint.get("read", "/widget", { success: Schema.String })),
);

/** A toy plugin declaring a configuration descriptor with a plain-string secret next to a `Redacted` one, so redaction is proved against a shape that could leak. */
class Widget extends AuthPlugin.Service<Widget, { readonly ok: true }>()("widget", {
  apiVersion: 1,
  contract: WidgetApi,
  config: [
    ConfigDescriptor.make(WidgetConfig, {
      sensitive: ["clientSecret"],
      audit: (value) =>
        value.minLength < 8
          ? [ConfigDescriptor.finding("warning", "widget-short", "minLength is below 8")]
          : [],
    }),
  ],
}) {
  static readonly layer = AuthPlugin.layer(Widget, {
    make: Effect.succeed<{ readonly ok: true }>({ ok: true }),
    handlers: HttpApiBuilder.group(WidgetApi, "widget", (handlers) =>
      handlers
        .handle("create", () => Effect.succeed("created"))
        .handle("read", () => Effect.succeed("read")),
    ),
  });
}

export const widgetOnly = Auth.make([Widget]);

// ---- the application Layer `seed admin` builds ----------------------------------------------

const adminRole = role({ name: "admin", permissions: [] });
const editorRole = role({ name: "editor", permissions: [] });

const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

const CoreLive = Layer.mergeAll(
  Users.layerSql.pipe(
    Layer.provide(Repositories.UsersRepositoryLive),
    Layer.provide(Hooks.BeforeUserDelete.layer),
  ),
  Accounts.layerSql.pipe(
    Layer.provide(Repositories.AccountsRepositoryLive.pipe(Layer.provide(EncryptionLive))),
  ),
  SqlTransaction.layerSql,
  cheapArgon2id.pipe(Layer.provide(NodeCrypto.layer)),
).pipe(
  Layer.provideMerge(
    AuthEvents.layer.pipe(
      Layer.provideMerge(
        AuditLog.layerSql.pipe(
          Layer.provide(Repositories.AuditLogRepositoryLive),
          Layer.provide(NodeCrypto.layer),
        ),
      ),
    ),
  ),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

/** Core services plus the Roles plugin (catalog: `admin`, `editor`) over the given SQL client. */
export const sqlApp = (sql: SqlClient.SqlClient) =>
  Roles.Roles.layerSql.pipe(
    Layer.provide(Roles.config([adminRole, editorRole])),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(Layer.succeed(SqlClient.SqlClient, sql)),
    Layer.provide(Slots.layer),
    Layer.provide(Layer.mergeAll(Erasure.registryLayer, DataExport.registryLayer)),
  );

/** The same without Roles: there is no administrative role concept to grant. */
export const sqlAppWithoutRoles = (sql: SqlClient.SqlClient) =>
  CoreLive.pipe(Layer.provideMerge(Layer.succeed(SqlClient.SqlClient, sql)));

/** Applies core's migrations and the composition's plugin migrations to the current client, as `migration apply --yes` does. */
export const migrate = Effect.gen(function* () {
  yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
  yield* Migrations.run(passwordAndRoles.migrations);
});

// ---- running the command tree ----------------------------------------------------------------

/** A credential store the Scenario owns, so no run ever touches the OS keychain or the home directory. */
export const memoryCredentials = Effect.gen(function* () {
  const ref = yield* Ref.make(Option.none<CredentialStore.Credential>());
  const writes = yield* Ref.make(0);
  const layer = Layer.succeed(
    CredentialStore.CredentialStore,
    CredentialStore.CredentialStore.of({
      backend: "memory",
      get: Ref.get(ref),
      set: (credential) =>
        Ref.set(ref, Option.some(credential)).pipe(
          Effect.andThen(Ref.update(writes, (n) => n + 1)),
        ),
      clear: Ref.set(ref, Option.none()),
    }),
  );
  return { ref, writes, layer };
});

/**
 * How the interactive login's second device behaves while the command polls (BEH-EA-307): `approve` (the
 * person confirms the printed code at the first wait), `deny`, `expire` (nobody does, and the code's lifetime
 * passes), `hurry` (time does not pass between the first waits, so the server answers `slow_down`; the person
 * approves at the fourth wait).
 */
export type PersonMode = "approve" | "deny" | "expire" | "hurry";

/** What the command's polling clock did, so a Then can read the schedule. */
export interface LoginTrace {
  readonly sleeps: ReadonlyArray<number>;
}

export interface RunResult {
  readonly argv: ReadonlyArray<string>;
  readonly code: number;
  readonly stdout: ReadonlyArray<string>;
  readonly stderr: ReadonlyArray<string>;
}

export const isRunResult = (value: unknown): value is RunResult =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "code") === "number" &&
  Array.isArray(Reflect.get(value, "stdout"));

export interface WorldShape {
  readonly outcomes: Outcomes;
  /** The SQLite client database-backed commands run over. */
  readonly sql: SqlClient.SqlClient;
  /** The application Layer `seed admin` builds (Users/Accounts/Roles/AuditLog over `sql`), typed so a step can read the audit log through it. */
  readonly app: ReturnType<typeof sqlApp>;
  /** What `awthaq.config.ts` currently exports; Givens replace parts of it. */
  readonly config: Ref.Ref<CliConfigModule.CliConfig>;
  readonly last: Ref.Ref<RunResult | undefined>;
  /** The real auth server the session commands talk to, once a Given has started one (BEH-EA-227). */
  readonly server: Ref.Ref<Option.Option<SessionServer>>;
  /** Environment variables the next runs see on top of the process's own (`AWTHAQ_TOKEN`, `AWTHAQ_BASE_URL`). */
  readonly env: Ref.Ref<Readonly<Record<string, string>>>;
  /** What the person on the second device does during an interactive login. */
  readonly person: Ref.Ref<PersonMode>;
  /** How many times a command wrote the credential store, across the scenario's runs. */
  readonly credentialWrites: Ref.Ref<number>;
  /** The waits the interactive login made between polls, newest run last. */
  readonly sleeps: Ref.Ref<ReadonlyArray<number>>;
  /** Scopes of the servers a scenario started, closed with the scenario. */
  readonly scopes: Ref.Ref<ReadonlyArray<Scope.Closeable>>;
}

export class World extends Context.Service<World, WorldShape>()("features/CliWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    const sql = yield* SqliteClient.make({ filename: ":memory:" }).pipe(
      Effect.provide(Reactivity.layer),
    );
    const world = World.of({
      outcomes: yield* makeOutcomes,
      sql,
      app: sqlApp(sql),
      config: yield* Ref.make(
        configOf(passwordAndRoles, { sql: Layer.succeed(SqlClient.SqlClient, sql) }),
      ),
      last: yield* Ref.make<RunResult | undefined>(undefined),
      server: yield* Ref.make(Option.none<SessionServer>()),
      env: yield* Ref.make<Readonly<Record<string, string>>>({}),
      person: yield* Ref.make<PersonMode>("approve"),
      credentialWrites: yield* Ref.make(0),
      sleeps: yield* Ref.make<ReadonlyArray<number>>([]),
      scopes: yield* Ref.make<ReadonlyArray<Scope.Closeable>>([]),
    });
    yield* Effect.addFinalizer(() =>
      Ref.get(world.scopes).pipe(
        Effect.flatMap((scopes) =>
          Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void), { discard: true }),
        ),
      ),
    );
    return world;
  }),
);

/** Adds environment variables the session commands see on the next runs. */
export const setEnv = (variables: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const world = yield* World;
    yield* Ref.update(world.env, (existing) => ({ ...existing, ...variables }));
  });

/**
 * Starts the real auth server the session commands talk to (BEH-EA-227), once per scenario, and points
 * `AWTHAQ_BASE_URL` at it. `device: false` leaves the device authorization routes out.
 */
export const ensureServer = (options?: { readonly device?: boolean }) =>
  Effect.gen(function* () {
    const world = yield* World;
    const existing = yield* Ref.get(world.server);
    if (Option.isSome(existing)) return existing.value;
    const scope = Scope.makeUnsafe();
    const server = yield* startSessionServer(options).pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    yield* Ref.set(world.server, Option.some(server));
    yield* Ref.update(world.scopes, (all) => [...all, scope]);
    yield* setEnv({ AWTHAQ_BASE_URL: server.baseUrl });
    return server;
  });

export const updateConfig = (change: Partial<CliConfigModule.CliConfig>) =>
  Effect.gen(function* () {
    const { config } = yield* World;
    yield* Ref.update(config, (current) => ({ ...current, ...change }));
  });

/** The process environment as the plain string record `ConfigProvider.fromEnv` takes. */
const definedEnv = (): Record<string, string> => {
  const defined: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) defined[name] = value;
  }
  return defined;
};

/** Runs `awthaq <argv>` in-process against the current configuration and records the outcome. */
export const runCommand = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const world = yield* World;
    const config = yield* Ref.get(world.config);
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];
    const capturing: Console.Console = {
      ...globalThis.console,
      log: (...values: ReadonlyArray<unknown>) => {
        stdout.push(values.map(String).join(" "));
      },
      error: (...values: ReadonlyArray<unknown>) => {
        stderr.push(values.map(String).join(" "));
      },
    };
    const stored = yield* memoryCredentials;
    const env = yield* Ref.get(world.env);
    const server = yield* Ref.get(world.server);
    const person = yield* Ref.get(world.person);
    yield* Ref.set(world.sleeps, []);
    /** The interactive login's clock: real time is `TestClock`, and the person acts inside the wait (BEH-EA-307). */
    const pacing: DeviceLogin.PacingShape = {
      sleep: (duration) =>
        Effect.gen(function* () {
          const waits = [...(yield* Ref.get(world.sleeps)), Duration.toSeconds(duration)];
          yield* Ref.set(world.sleeps, waits);
          const printed = /confirm the code ([A-Z]{4}-[A-Z]{4})/.exec(stderr.join("\n"))?.[1];
          if (person === "expire") return yield* TestClock.adjust(Duration.minutes(16));
          if (person === "hurry" && waits.length < 4) return;
          if (Option.isSome(server) && printed !== undefined) {
            yield* server.value.decide(
              printed,
              "second-device@example.com",
              person === "deny" ? "deny" : "approve",
            );
          }
          yield* TestClock.adjust(duration.pipe(Duration.max(Duration.minutes(1))));
        }),
    };
    const overlay =
      Object.keys(env).length === 0
        ? Layer.empty
        : ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...definedEnv(), ...env } }));
    // As the binary wires it: `AWTHAQ_TOKEN` (with `AWTHAQ_BASE_URL`) wins over the store and is never written to it.
    const credentials = Layer.effect(
      CredentialStore.CredentialStore,
      Effect.gen(function* () {
        const store = yield* CredentialStore.CredentialStore;
        return CredentialStore.CredentialStore.of(yield* CredentialStore.withEnvOverride(store));
      }),
    ).pipe(Layer.provide(stored.layer), Layer.provide(overlay));
    const exit = yield* Effect.exit(
      Cli.run(argv).pipe(
        Effect.provide(
          Layer.mergeAll(
            CliConfigModule.layerFixed(config),
            credentials,
            Browser.layerNone,
            NodeHttpClient.layerUndici,
            NodeServices.layer,
          ),
        ),
        Effect.provideService(DeviceLogin.Pacing, pacing),
        Effect.provide(overlay),
        Effect.provideService(Console.Console, capturing),
      ),
    );
    const wrote = yield* Ref.get(stored.writes);
    yield* Ref.update(world.credentialWrites, (n) => n + wrote);
    const code = Exit.isSuccess(exit)
      ? 0
      : (() => {
          const error = Exit.findErrorOption(exit);
          return error._tag === "Some" ? Runtime.getErrorExitCode(error.value) : 1;
        })();
    const result: RunResult = { argv, code, stdout, stderr };
    yield* Ref.set(world.last, result);
    return result;
  });

/** Splits a step's command text ("awthaq migration apply --yes") into the argv the tree receives. */
export const argvOf = (command: string): ReadonlyArray<string> =>
  command
    .trim()
    .split(/\s+/)
    .filter((part, index) => !(index === 0 && part === "awthaq"));

export const lastRun = Effect.gen(function* () {
  const { last } = yield* World;
  const found = yield* Ref.get(last);
  return found === undefined ? yield* Effect.die(new Error("no command has run yet")) : found;
});

export const combined = (result: RunResult) => [...result.stdout, ...result.stderr].join("\n");

/** Exit codes a Then names by the typed failure that maps to them (BEH-EA-225). */
export const EXIT = CliErrors.ExitCode;
