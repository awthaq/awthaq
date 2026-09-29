// @awthaq/cli — Config
//
// ADR-EA-027 §4, decision 07 §2: the CLI operates on the application's own
// composition, which is a TypeScript value, not a serialized artifact — so it
// imports it. The consuming project exports it from `awthaq.config.ts` (resolved
// like a Vite or drizzle-kit config; `--config <path>` overrides), and the
// default export is one of:
//
//   - the composition itself (`Auth.make([...])`, a `Built<P>`);
//   - an Effect that produces the composition (an app that needs setup first);
//   - `defineConfig({ auth, config?, sql?, app?, production? })`, adding the
//     optional Layers the commands of BEH-EA-208's second class need.
//
// Loading never serves anything: the composition's `api`, `migrations` and
// `manifest` are static (BEH-EA-208), and the optional Layers are only *built*
// by the commands whose class allows it.
//
// The `awthaq.config.ts` contract is small on purpose (it becomes an interface
// the CLI depends on indefinitely): `auth` is required; everything else is
// optional and a command that needs a missing piece fails with a typed error
// naming it (`DatabaseUnavailable`, `ApplicationUnavailable`).
//
// Importing a `.ts` module needs a runtime that can load one (Node with native
// type stripping, Bun, or `tsx awthaq …`); when the import fails for that
// reason the message says so.

import type { Auth, AuthPlugin, Migrations } from "@awthaq/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { pathToFileURL } from "node:url";
import { ConfigUnavailable, LinkProblem } from "./CliErrors.ts";

/** What a command reads off a composition: all static (BEH-EA-208). */
export interface LoadedAuth {
  /**
   * `AuthPlugin.ContractData`, not `HttpApi`: `HttpApi`'s `Groups` parameter is invariant, so no
   * single `HttpApi` type accepts every `Built<P>['api']`; the data shape (`identifier`, `groups`)
   * does, and `Routes`/`Openapi` narrow it to the real value with `HttpApi.isHttpApi`.
   */
  readonly api: AuthPlugin.ContractData;
  readonly migrations: Migrations.Migrations;
  readonly manifest: Auth.Manifest;
}

/** The whole of `awthaq.config.ts` once normalized. */
export interface CliConfig {
  readonly auth: LoadedAuth;
  /**
   * The application's configuration Layer (`Password.config(...)`,
   * `Sessions.config(...)`, ...), which needs no ports and no database. `doctor` and
   * `config list` build it on its own to read the values it sets (BEH-EA-229).
   */
  readonly config: Layer.Layer<never, unknown> | undefined;
  /** The SQL client the database-backed commands use, when `--database-url` is not given. */
  readonly sql: Layer.Layer<SqlClient.SqlClient, unknown> | undefined;
  /**
   * The application Layer with every port and the SQL client already provided
   * (`auth.layer.pipe(Layer.provide(ports))`): what `seed admin`, `import` and
   * `doctor --build` build on a short-lived runtime, never serving it.
   */
  readonly app: Layer.Layer<never, unknown> | undefined;
  /** Overrides `NODE_ENV` for the insecure-default audit. */
  readonly production: boolean | undefined;
}

/** The shape `awthaq.config.ts` may default-export (besides the bare composition). */
export interface ConfigInput {
  readonly auth: LoadedAuth | Effect.Effect<LoadedAuth, unknown>;
  readonly config?: Layer.Layer<never, unknown> | undefined;
  readonly sql?: Layer.Layer<SqlClient.SqlClient, unknown> | undefined;
  readonly app?: Layer.Layer<never, unknown> | undefined;
  readonly production?: boolean | undefined;
}

/** Identity, for typing: `export default defineConfig({ auth, sql, app })`. */
export const defineConfig = (input: ConfigInput): ConfigInput => input;

const isRecord = (u: unknown): u is Readonly<Record<string, unknown>> =>
  typeof u === "object" && u !== null;

/** A composition: `Auth.make`'s own `Built<P>` has all three static fields. */
export const isLoadedAuth = (u: unknown): u is LoadedAuth =>
  isRecord(u) &&
  HttpApi.isHttpApi(u["api"]) &&
  Array.isArray(u["migrations"]) &&
  isRecord(u["manifest"]) &&
  Array.isArray(u["manifest"]["plugins"]);

/**
 * The contract says a config Effect needs no services (it produces the
 * composition); `Effect.isEffect` is the only runtime check there is, so the
 * narrowing states the contract's `R = never`.
 */
const isSelfContainedEffect = (u: unknown): u is Effect.Effect<unknown, unknown> =>
  Effect.isEffect(u);

const isPlainLayer = (u: unknown): u is Layer.Layer<never, unknown> => Layer.isLayer(u);

const isSqlLayer = (u: unknown): u is Layer.Layer<SqlClient.SqlClient, unknown> =>
  Layer.isLayer(u);

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";

const linkErrorCodes: ReadonlySet<string> = new Set([
  "CircularPluginDependency",
  "EmptyPluginTuple",
  "GroupIdConflict",
  "RouteConflict",
  "LinkerInvariantViolation",
]);

/** `Auth.make` raises a tagged link error while the module is evaluated; anything else is just a load failure. */
const asLoadFailure = (error: unknown): LinkProblem | ConfigUnavailable => {
  if (isRecord(error) && typeof error["_tag"] === "string" && linkErrorCodes.has(error["_tag"])) {
    return new LinkProblem({ code: error["_tag"], message: describeError(error) });
  }
  const message = describeError(error);
  const needsTypeStripping =
    isRecord(error) &&
    (error["code"] === "ERR_UNKNOWN_FILE_EXTENSION" || error["code"] === "ERR_MODULE_NOT_FOUND");
  return new ConfigUnavailable({
    message: needsTypeStripping
      ? `could not load the configuration module (${message}). A TypeScript config needs a runtime that can load .ts (Node with native type stripping, Bun, or \`tsx\`).`
      : `could not load the configuration module: ${message}`,
  });
};

const normalizeInput = (raw: unknown): Effect.Effect<CliConfig, LinkProblem | ConfigUnavailable> =>
  Effect.gen(function* () {
    const resolved = isSelfContainedEffect(raw)
      ? yield* raw.pipe(Effect.mapError(asLoadFailure))
      : raw;
    if (isLoadedAuth(resolved)) {
      return { auth: resolved, config: undefined, sql: undefined, app: undefined, production: undefined };
    }
    if (!isRecord(resolved) || !("auth" in resolved)) {
      return yield* new ConfigUnavailable({
        message:
          "the configuration module must default-export the Auth.make composition, an Effect producing it, or defineConfig({ auth, ... })",
      });
    }
    const auth = isSelfContainedEffect(resolved["auth"])
      ? yield* resolved["auth"].pipe(Effect.mapError(asLoadFailure))
      : resolved["auth"];
    if (!isLoadedAuth(auth)) {
      return yield* new ConfigUnavailable({
        message: "`auth` in the configuration module is not an Auth.make composition",
      });
    }
    const optionalLayer = <A>(name: string, value: unknown, guard: (u: unknown) => u is A) =>
      value === undefined
        ? Effect.succeed(undefined)
        : guard(value)
          ? Effect.succeed(value)
          : Effect.fail(new ConfigUnavailable({ message: `\`${name}\` in the configuration module is not a Layer` }));
    const config = yield* optionalLayer("config", resolved["config"], isPlainLayer);
    const sql = yield* optionalLayer("sql", resolved["sql"], isSqlLayer);
    const app = yield* optionalLayer("app", resolved["app"], isPlainLayer);
    const production =
      typeof resolved["production"] === "boolean" ? resolved["production"] : undefined;
    return { auth, config, sql, app, production };
  });

/**
 * Normalizes an already-imported module namespace (or any value a caller hands
 * over): the pure half of loading, used by tests and by programmatic callers.
 */
export const fromModule = (mod: unknown) => {
  const raw = isRecord(mod) && "default" in mod ? mod["default"] : mod;
  return normalizeInput(raw);
};

const candidates = ["awthaq.config.ts", "awthaq.config.mts", "awthaq.config.js", "awthaq.config.mjs"];

/** How the CLI obtains its configuration: the real one imports the file; tests provide a fixed value. */
export interface ConfigSourceShape {
  readonly load: (
    path: string | undefined,
  ) => Effect.Effect<CliConfig, LinkProblem | ConfigUnavailable>;
}

export class ConfigSource extends Context.Service<ConfigSource, ConfigSourceShape>()(
  "awthaq/cli/ConfigSource",
) {}

/** Resolves `awthaq.config.*` (or `--config <path>`) against the working directory, then imports it. */
export const layerFile = Layer.effect(
  ConfigSource,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const locate = Effect.fnUntraced(function* (explicit: string | undefined) {
      if (explicit !== undefined) {
        const absolute = path.resolve(explicit);
        if (yield* fs.exists(absolute).pipe(Effect.orElseSucceed(() => false))) return absolute;
        return yield* new ConfigUnavailable({ message: `no configuration module at ${absolute}` });
      }
      for (const name of candidates) {
        const absolute = path.resolve(name);
        if (yield* fs.exists(absolute).pipe(Effect.orElseSucceed(() => false))) return absolute;
      }
      return yield* new ConfigUnavailable({
        message: `no awthaq.config.ts in ${path.resolve(".")} (or pass --config <path>): export your Auth.make composition as its default export`,
      });
    });
    return ConfigSource.of({
      load: (explicit) =>
        locate(explicit).pipe(
          Effect.flatMap((absolute) =>
            Effect.tryPromise({
              try: () => import(/* @vite-ignore */ pathToFileURL(absolute).href),
              catch: asLoadFailure,
            }),
          ),
          Effect.flatMap(fromModule),
        ),
    });
  }),
);

/** A fixed configuration, for tests and for embedding the CLI in an application's own entry point. */
export const layerFixed = (config: CliConfig) =>
  Layer.succeed(ConfigSource, ConfigSource.of({ load: () => Effect.succeed(config) }));
