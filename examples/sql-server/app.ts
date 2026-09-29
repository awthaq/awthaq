// @awthaq/example-sql-server: the composition
//
// The app's layers, without starting anything: `index.ts` serves them on :3002 and
// `test/smoke.test.ts` boots the very same `AppLayer` in-process over an in-memory SQLite
// database, so the example cannot drift from what its test proves (a sign-up, the mailed
// verification token, a sign-in, all persisted through the real repositories).
//
// Password over SQL, end to end: a migration run, the encrypted-account repositories, the durable
// audit log, a SQL-backed rate limiter, one SQL transaction domain. The backend is chosen at
// startup: `DATABASE_URL` set means Postgres, otherwise a SQLite file (`SQLITE_FILE`, default
// `./awthaq.sqlite`; `:memory:` works too). That is the one-layer substitution a deployment makes
// when it outgrows the embedded database; nothing else below mentions a dialect.

import { createServer } from "node:http";
import {
  Accounts,
  AuditLog,
  Auth,
  AuthEvents,
  DataExport,
  Erasure,
  Hooks,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { Password } from "@awthaq/password";
import {
  ClientAddress,
  Encryption,
  KeyProvider,
  Mailer,
  PasswordHasher,
  RateLimiter,
  SqlTransaction,
} from "@awthaq/ports";
import { Authentication, AuthHttp, BodyLimit, Csrf } from "@awthaq/server";
import { CoreMigrations, RateLimiterStoreSql, Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Migrator from "effect/unstable/sql/Migrator";

// 1. The plugin composition: `Auth.make` folds each plugin's HttpApi contract and Layer into one
//    `api`/`layer` pair. Add more (`Organization`, `OAuth`, `Passkey`, ...) by listing them here
//    and providing the ports and migrations each adds.
const auth = Auth.make([Password.Password]);

// 2. The database, chosen by configuration. Both branches provide the same `SqlClient`, which is
//    all the repositories and the migrator ask for; the dialect is read from the client.
const PostgresLive = PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") });
const SqliteLive = SqliteClient.layerConfig({
  filename: Config.String("SQLITE_FILE").pipe(Config.withDefault("./awthaq.sqlite")),
});
const SqlLive = Layer.unwrap(
  Effect.map(Config.option(Config.String("DATABASE_URL")), (url) =>
    Option.isSome(url) ? PostgresLive : SqliteLive,
  ),
);
// The forward-only core migrations, run once when the layer is built (the same set the package
// contract tests run against SQLite and Postgres alike).
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

// 3. Encryption keys. `KeyProvider.layerEnv` is the real path (`AWTHAQ_ENCRYPTION_KEYS`, or the
//    single `AWTHAQ_ENCRYPTION_KEY`) and is used whenever a key is configured. With none, this
//    *example* opts into `KeyProvider.layerEphemeral` (IC-010): a random key for this run,
//    logged loudly, which a `NODE_ENV=production` process refuses. Password stores no provider
//    tokens, so nothing here is lost on restart; an OAuth deployment must configure a real key.
const KeysLive = Layer.unwrap(
  Effect.gen(function* () {
    const configured = yield* Config.option(Config.String("AWTHAQ_ENCRYPTION_KEY"));
    const keyset = yield* Config.option(Config.String("AWTHAQ_ENCRYPTION_KEYS"));
    return Option.isSome(configured) || Option.isSome(keyset)
      ? KeyProvider.layerEnv
      : KeyProvider.layerEphemeral;
  }),
);
const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(KeysLive),
  Layer.provide(NodeCrypto.layer),
);

const RepositoriesLive = Layer.mergeAll(
  Repositories.UsersRepositoryLive,
  Repositories.AccountsRepositoryLive.pipe(Layer.provide(EncryptionLive)),
  Repositories.SessionsRepositoryLive,
  Repositories.VerificationRepositoryLive,
  Repositories.VerificationReservationsRepositoryLive,
  Repositories.AuditLogRepositoryLive,
).pipe(Layer.provideMerge(SqlLive), Layer.provideMerge(Migrated));

// 4. The domain services over those repositories; `AuthEvents` writes every event into the
//    durable `AuditLog` table.
const CoreLive = Layer.mergeAll(
  Users.layerSql,
  Accounts.layerSql,
  Sessions.layerSql,
  Verification.layerSql,
).pipe(
  Layer.provideMerge(AuthEvents.layer.pipe(Layer.provideMerge(AuditLog.layerSql))),
  Layer.provideMerge(RepositoriesLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

// 5. The rate limiter enforces the rules the plugin registers, against a shared SQL store so the
//    limits hold across replicas and restarts.
const RateLimiterMigrated = Layer.effectDiscard(RateLimiterStoreSql.migrate).pipe(
  Layer.provide(SqlLive),
);
const RateLimiterLive = RateLimiter.layer.pipe(
  Layer.provide(RateLimiterStoreSql.layerStoreSql),
  Layer.provide(RateLimiterMigrated),
  Layer.provide(SqlLive),
);

// 6. Cross-cutting services: erasure and export over the hook registries, one SQL transaction
//    domain, the client-address resolver (`layerDirect` reads the socket peer; behind a proxy
//    use `layerTrustedProxy`) and CSRF protection keyed by `AWTHAQ_CSRF_SECRET` (>= 32 bytes).
const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(Csrf.layerConfig),
  Layer.provide(NodeCrypto.layer),
);
const ServicesLive = Layer.mergeAll(Erasure.layer, DataExport.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(CsrfProtectionLive, ClientAddress.layerDirect, SqlTransaction.layerSql),
  ),
);

// 7. Mount the composed api. The OpenAPI document and Scalar UI are unauthenticated, so they are
//    off unless `AWTHAQ_EXPOSE_DOCS=true`.
const ExposeDocs = Config.Boolean("AWTHAQ_EXPOSE_DOCS").pipe(Config.withDefault(false));
const RoutesLive = Layer.unwrap(
  Effect.map(ExposeDocs, (expose) =>
    AuthHttp.routes(auth.api, expose ? { openapiPath: "/openapi.json" } : {}).pipe(
      Layer.provide(AuthHttp.coreHandlers),
      Layer.provide(auth.layer),
    ),
  ),
);
const DocsLive = Layer.unwrap(
  Effect.map(ExposeDocs, (expose) => (expose ? AuthHttp.docs(auth.api) : Layer.empty)),
);

// `Mailer.layerConsole` prints every message, verification token included, to the log so a run
// needs no inbox. Never for production: a real deployment provides its own `Mailer`.
const makeAppLayer = (httpClient: Layer.Layer<HttpClient.HttpClient>) =>
  Layer.mergeAll(RoutesLive, DocsLive).pipe(
    Layer.provideMerge(AuthenticationLive),
    Layer.provideMerge(ServicesLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(Hooks.HooksLive),
    Layer.provideMerge(
      Layer.mergeAll(PasswordHasher.layerArgon2id, Mailer.layerConsole, RateLimiterLive).pipe(
        Layer.provideMerge(NodeCrypto.layer),
      ),
    ),
    Layer.provideMerge(RateLimits.layer),
    Layer.provide(httpClient),
    Layer.provideMerge(
      Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
        Layer.provideMerge(FileSystem.layerNoop({})),
      ),
    ),
    Layer.provideMerge(HttpRouter.layer),
  );

const AppLayer = makeAppLayer(FetchHttpClient.layer);

/**
 * Boots the app in-process (no socket) for tests: the web handler and a disposer that closes the
 * database. `env` replaces the process environment as the configuration source, `httpClient` is
 * the breach-check transport and `logger` replaces the default loggers (a test reads the mail
 * the console mailer prints through it).
 */
export const buildApp = (
  env: Record<string, string>,
  httpClient: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer,
  logger: Layer.Layer<never> = Layer.empty,
) => {
  const memoMap = Layer.makeMemoMapUnsafe();
  const layer = makeAppLayer(httpClient).pipe(
    Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Layer.provideMerge(logger),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(layer, { memoMap });
  return { handler, dispose };
};

// 8. A real listening server. `BodyLimit.layer` bounds every request body (256 KiB by default).
const serverLayer = (port: number) =>
  HttpRouter.serve(BodyLimit.layer.pipe(Layer.provideMerge(AppLayer))).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { port })),
  );

/** Serve on `port` until interrupted. */
export const main = (port: number) =>
  Layer.launch(
    Layer.merge(
      serverLayer(port),
      Layer.effectDiscard(
        Effect.logInfo(`awthaq example (SQL-backed, Password) listening on :${port}`),
      ),
    ),
  );
