// @awthaq/example-sql-server: the composition
//
// The app's layers, without starting anything: `index.ts` serves them on :3002 and `test/smoke.test.ts` boots the
// very same `makeAppLayer` in-process over SQLite, so the example cannot drift from what its test proves (a sign-up,
// the mailed verification token, a sign-in, an organization, all persisted through the real SQL store adapters).
//
// Password and Organization over SQL, end to end, served by `AuthHost.layer` (ADR-EA-044): core's migrations and
// then the composition's, the sealed provider tokens and OAuth client secrets, the durable audit log, a SQL-backed
// rate limiter, one SQL transaction domain. The backend is chosen at startup: `DATABASE_URL` set means Postgres,
// otherwise a SQLite file (`SQLITE_FILE`, default `./awthaq.sqlite`; `:memory:` works too). That is the one-layer
// substitution a deployment makes when it outgrows the embedded database; nothing else below mentions a dialect.

import { createServer } from "node:http";
import { Auth, type Migrations } from "@awthaq/core";
import {
  Organization,
  type OrganizationActiveContext,
  type OrganizationAuthority,
  type OrganizationDeletion,
  type OrganizationDirectory,
  type OrganizationInvitations,
  type OrganizationMembers,
  type OrganizationRoles,
  type OrganizationTeams,
} from "@awthaq/organization";
import { Password, type PasswordCredential } from "@awthaq/password";
import {
  ClientAddress,
  Encryption,
  KeyProvider,
  Mailer,
  PasswordHasher,
  RateLimiter,
} from "@awthaq/ports";
import { AuthHost, Csrf } from "@awthaq/server";
import { RateLimiterStoreSql } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";

// 1. Password and Organization. Add more by listing them: `AuthHost` selects each plugin's SQL records, provides its
//    hook points and runs its migrations; what is left for you is the ports it requires (the compiler lists them).
const auth = Auth.make([Password.Password, Organization.Organization]);

// 2. The database, chosen by configuration. Both branches provide the same `SqlClient`, which is all the store
//    adapters and the migrator ask for; the dialect is read from the client.
const PostgresLive = PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") });
const SqliteLive = SqliteClient.layerConfig({
  filename: Config.String("SQLITE_FILE").pipe(Config.withDefault("./awthaq.sqlite")),
});
const SqlLive = Layer.unwrap(
  Effect.map(Config.option(Config.String("DATABASE_URL")), (url) =>
    Option.isSome(url) ? PostgresLive : SqliteLive,
  ),
);

// 3. Encryption keys. `KeyProvider.layerEnv` is the real path (`AWTHAQ_ENCRYPTION_KEYS`, or the single
//    `AWTHAQ_ENCRYPTION_KEY`) and is used whenever a key is configured. With none, this *example* opts into
//    `KeyProvider.layerEphemeral` (IC-010): a random key for this run, logged loudly, which a `NODE_ENV=production`
//    process refuses. Organization seals OAuth client secrets under it, so a real deployment configures a key.
const KeysLive = Layer.unwrap(
  Effect.gen(function* () {
    const configured = yield* Config.option(Config.String("AWTHAQ_ENCRYPTION_KEY"));
    const keyset = yield* Config.option(Config.String("AWTHAQ_ENCRYPTION_KEYS"));
    return Option.isSome(configured) || Option.isSome(keyset)
      ? KeyProvider.layerEnv
      : KeyProvider.layerEphemeral;
  }),
);
const EncryptionLive = Encryption.layer.pipe(Layer.provide(KeysLive));

// 4. The rate limiter enforces the rules the plugins register, against a shared SQL store (its own table and its
//    own ledger, an adapter of the `RateLimiter` port) so the limits hold across replicas and restarts.
const RateLimiterLive = RateLimiter.layer.pipe(
  Layer.provide(RateLimiterStoreSql.layerStoreSql),
  Layer.provide(Layer.effectDiscard(RateLimiterStoreSql.migrate).pipe(Layer.provide(SqlLive))),
  Layer.provide(SqlLive),
);

// `AWTHAQ_MIGRATE_ON_BOOT=false` when `awthaq migration apply` is your deploy step: the server then refuses to start
// while anything is pending, and never migrates itself. The OpenAPI document and Scalar UI are unauthenticated, so
// they are off unless `AWTHAQ_EXPOSE_DOCS=true`.
const MigrateOnBoot = Config.Boolean("AWTHAQ_MIGRATE_ON_BOOT").pipe(Config.withDefault(true));
const ExposeDocs = Config.Boolean("AWTHAQ_EXPOSE_DOCS").pipe(Config.withDefault(false));

// 5. The servable layer. `AuthHost` derives everything that is a function of the plugin tuple; this app provides
//    the database, the CSRF secret (`AWTHAQ_CSRF_SECRET`, >= 32 bytes) and its ports. `Mailer.layerConsole` prints
//    every message, verification token included, to the log so a run needs no inbox: never for production.
export const makeAppLayer = (httpClient: Layer.Layer<HttpClient.HttpClient>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const migrate = yield* MigrateOnBoot;
      const expose = yield* ExposeDocs;
      return AuthHost.layer(auth, {
        persistence: { records: "sql", client: SqlLive, migrations: migrate ? "apply" : "verify" },
        csrf: Csrf.layerConfig,
        ...(expose ? { openapiPath: "/openapi.json", docsPath: "/docs" } : {}),
      });
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        PasswordHasher.layerArgon2id,
        Mailer.layerConsole,
        RateLimiterLive,
        ClientAddress.layerDirect,
        EncryptionLive,
        httpClient,
      ),
    ),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
  );

/** Keeps Password's exposed credential module (in `makeAppLayer`'s output) nameable for declaration emit. @public */
export type PasswordServices = PasswordCredential.PasswordCredential;

/** Keeps Organization's exposed services (in `makeAppLayer`'s output) nameable for declaration emit. @public */
export type OrganizationServices =
  | OrganizationActiveContext.OrganizationActiveContext
  | OrganizationAuthority.OrganizationAuthority
  | OrganizationDeletion.OrganizationDeletion
  | OrganizationDirectory.OrganizationDirectory
  | OrganizationInvitations.OrganizationInvitations
  | OrganizationMembers.OrganizationMembers
  | OrganizationRoles.OrganizationRoles
  | OrganizationTeams.OrganizationTeams;

/** What a boot can fail with besides configuration: a pending migration in verify mode, drift, a failed batch. @public */
export type BootFailure = Migrations.OnBuildError;

// 6. A real listening server.
const serverLayer = (port: number) =>
  HttpRouter.serve(makeAppLayer(FetchHttpClient.layer)).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { port })),
  );

/** Serve on `port` until interrupted. */
export const main = (port: number) =>
  Layer.launch(
    Layer.merge(
      serverLayer(port),
      Layer.effectDiscard(
        Effect.logInfo(
          `awthaq example (SQL-backed, Password + Organization) listening on :${port}`,
        ),
      ),
    ),
  );
