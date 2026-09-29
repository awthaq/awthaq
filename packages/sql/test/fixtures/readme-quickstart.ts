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
import { CoreMigrations, RateLimiterStoreSql, Repositories } from "@awthaq/sql";
import {
  ClientAddress,
  Encryption,
  KeyProvider,
  Mailer,
  PasswordHasher,
  RateLimiter,
  SqlTransaction,
} from "@awthaq/ports";
import { Password } from "@awthaq/password";
import { Authentication, AuthHttp, BodyLimit, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Migrator from "effect/unstable/sql/Migrator";

// 1. Compose the Password plugin. `Auth.make` validates the plugin tuple at
//    the type level (no duplicate ids, no missing `dependsOn`) and folds
//    every plugin's own HttpApi contract and Layer into one `api`/`layer`
//    pair — here that's just Password, but the same call takes more
//    (`[Password, OAuth, Passkey, Organization, Roles, Admin, Jwt, ...]`) once
//    you provide the ports and migrations each one adds (see "Plugins").
const auth = Auth.make([Password.Password]);

// 2. A real Postgres connection and a real, forward-only migration run —
//    the same `Migrator` and migration set `packages/sql`'s own contract
//    tests run against SQLite and Postgres alike.
const SqlLive = PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") });
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

// 3. Provider tokens (OAuth access/refresh tokens) are encrypted at rest;
//    `KeyProvider.layerEnv` reads the keyset from `AWTHAQ_ENCRYPTION_KEYS` /
//    `AWTHAQ_ENCRYPTION_KEY_ID` (see "Encryption keys" below) even when no
//    OAuth plugin is installed, since the `accounts` table's encryption
//    columns are shared, core-owned schema.
const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(KeyProvider.layerEnv),
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

// 4. The domain services, backed by those repositories instead of memory.
//    `AuthEvents` publishes every event into the durable `AuditLog` table.
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

// 5. The rate limiter enforces the limits every plugin registers (the
//    sign-in / sign-up / reset rules) against a shared SQL store, so the
//    limits hold across replicas and restarts. `RateLimiter.layerPermissive`
//    disables limiting: tests only, never production. If the store is
//    unreachable, `RateLimiter.layer` fails open by default; see
//    `RateLimiter.config`.
const RateLimiterMigrated = Layer.effectDiscard(RateLimiterStoreSql.migrate).pipe(
  Layer.provide(SqlLive),
);
const RateLimiterLive = RateLimiter.layer.pipe(
  Layer.provide(RateLimiterStoreSql.layerStoreSql),
  Layer.provide(RateLimiterMigrated),
  Layer.provide(SqlLive),
);

//    Swap the remaining ports for your own: a real mailer
//    (SMTP/SES/Resend/...) in place of `Mailer.layerConsole` — which logs every
//    message with its token so a local run needs no inbox, and must never reach
//    production — and, if you want to tune the password policy,
//    `Password.config(...)`. Breach screening (HIBP, k-anonymity) is on by
//    default and fails open; `Password.config({ breachCheck: false })` turns it off.
//    A real adapter maps a provider error to `Mailer.MailDeliveryFailed` and never
//    logs `to` or `data`: they carry the recipient and the verification or reset token.
const consoleMailer = Mailer.layerConsole;

// 6. Cross-cutting services every core flow needs: the hook points (and the
//    erasure/export registries plugins contribute to), account erasure and
//    export over them, one SQL transaction domain, the client-address
//    resolver (`layerDirect` reads the socket peer; behind a proxy use
//    `layerTrustedProxy`), and CSRF protection keyed by `AWTHAQ_CSRF_SECRET`
//    (at least 32 bytes; see "Configuration").
const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(Csrf.layerConfig),
  Layer.provide(NodeCrypto.layer),
);
const ServicesLive = Layer.mergeAll(Erasure.layer, DataExport.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(CsrfProtectionLive, ClientAddress.layerDirect, SqlTransaction.layerSql),
  ),
);

// 7. Mount the composed api onto the router — `AuthHttp.routes` registers
//    with whatever `HttpRouter` is ambient (no gateway/adapter layer).
//    `auth.api` is one document: the plugins' groups plus core's own
//    Session/Account groups, whose handlers are `AuthHttp.coreHandlers`.
//    The OpenAPI document and the Scalar UI are unauthenticated, so they are
//    off unless `AWTHAQ_EXPOSE_DOCS=true` (`awthaq openapi` exports the
//    document offline).
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
const AppLayer = Layer.mergeAll(RoutesLive, DocsLive).pipe(
  Layer.provideMerge(AuthenticationLive),
  Layer.provideMerge(ServicesLive),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(
    Layer.mergeAll(PasswordHasher.layerArgon2id, consoleMailer, RateLimiterLive).pipe(
      Layer.provideMerge(NodeCrypto.layer),
    ),
  ),
  Layer.provideMerge(RateLimits.layer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provideMerge(
    Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
      Layer.provideMerge(FileSystem.layerNoop({})),
    ),
  ),
  Layer.provideMerge(HttpRouter.layer),
);

// 8. `HttpRouter.serve` is the same real serving path `AuthHttp.ts`'s own
//    header comment documents alongside `HttpRouter.toWebHandler` (used
//    instead in tests, and in any Fetch-native runtime — Bun, Deno,
//    Cloudflare Workers — since it returns a portable `(Request) =>
//    Promise<Response>` handler rather than binding a Node socket).
//    `BodyLimit.layer` bounds every request body (256 KiB by default, 413
//    beyond it; `BodyLimit.config({ maxBytes })` overrides): Effect's server
//    reads bodies with no cap unless one is set.
const ServerLive = HttpRouter.serve(BodyLimit.layer.pipe(Layer.provideMerge(AppLayer))).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
);

Layer.launch(ServerLive).pipe(NodeRuntime.runMain);
