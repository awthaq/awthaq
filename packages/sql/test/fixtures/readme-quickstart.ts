import { createServer } from "node:http";
import { Auth } from "@awthaq/core";
import {
  ClientAddress,
  Encryption,
  KeyProvider,
  Mailer,
  PasswordHasher,
  RateLimiter,
} from "@awthaq/ports";
import { Password } from "@awthaq/password";
import { AuthHost, Csrf } from "@awthaq/server";
import { RateLimiterStoreSql } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";

// 1. Compose the Password plugin. `Auth.make` validates the plugin tuple at the type level (no duplicate ids, no
//    missing `dependsOn`) and folds every plugin's HttpApi contract and Layer into one `api`/`layer` pair. Add more
//    (`[Password, OAuth, Passkey, Organization, Roles, Admin, Jwt, ...]`) by listing them: `AuthHost` selects each
//    plugin's SQL records, provides its hook points and runs its migrations; what is left for you is the ports it
//    requires, which the compiler lists (see "Plugins").
const auth = Auth.make([Password.Password]);

// 2. A real Postgres connection. `AuthHost` runs core's migrations and then the plugins' on it before anything else
//    is built over it (`migrations: "verify"` instead refuses to start while any is pending, for a deploy that runs
//    `awthaq migration apply`).
const SqlLive = PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") });

// 3. Provider tokens (OAuth access/refresh tokens) are encrypted at rest; `KeyProvider.layerEnv` reads the keyset
//    from `AWTHAQ_ENCRYPTION_KEYS` / `AWTHAQ_ENCRYPTION_KEY_ID` (see "Encryption keys" below) even when no OAuth
//    plugin is installed, since the `accounts` table's encryption columns are shared, core-owned schema.
const EncryptionLive = Encryption.layer.pipe(Layer.provide(KeyProvider.layerEnv));

// 4. The rate limiter enforces the limits every plugin registers against a shared SQL store (its own table and
//    ledger), so the limits hold across replicas and restarts. `RateLimiter.layerPermissive` disables limiting:
//    tests only. If the store is unreachable, `RateLimiter.layer` fails open by default; see `RateLimiter.config`.
const RateLimiterLive = RateLimiter.layer.pipe(
  Layer.provide(RateLimiterStoreSql.layerStoreSql),
  Layer.provide(Layer.effectDiscard(RateLimiterStoreSql.migrate).pipe(Layer.provide(SqlLive))),
  Layer.provide(SqlLive),
);

// 5. Your ports. Swap `Mailer.layerConsole` (it logs every message with its token so a local run needs no inbox,
//    and must never reach production) for a real mailer (SMTP/SES/Resend/...); a real adapter maps a provider error
//    to `Mailer.MailDeliveryFailed` and never logs `to` or `data`. `ClientAddress.layerDirect` reads the socket peer
//    (behind a proxy use `layerTrustedProxy`). `FetchHttpClient` is Password's breach-screening transport (HIBP,
//    k-anonymity; on by default, fails open; `Password.config({ breachCheck: false })` turns it off).
const Ports = Layer.mergeAll(
  PasswordHasher.layerArgon2id,
  Mailer.layerConsole,
  RateLimiterLive,
  ClientAddress.layerDirect,
  EncryptionLive,
  FetchHttpClient.layer,
).pipe(Layer.provideMerge(NodeCrypto.layer));

// 6. The servable layer (`@awthaq/server`'s `AuthHost`): the routes for `auth.api` (the plugins' groups plus core's
//    Session/Account groups and their handlers), the SQL stores and core services, the plugins' records and hook
//    points, the registries, the middleware the groups declare, CSRF protection keyed by `AWTHAQ_CSRF_SECRET` (at
//    least 32 bytes; see "Configuration"), the request context and a 256 KiB body cap. The OpenAPI document and the
//    Scalar UI are unauthenticated, so they are off unless `AWTHAQ_EXPOSE_DOCS=true`.
const AppLayer = Layer.unwrap(
  Effect.map(Config.Boolean("AWTHAQ_EXPOSE_DOCS").pipe(Config.withDefault(false)), (expose) =>
    AuthHost.layer(auth, {
      persistence: { records: "sql", client: SqlLive, migrations: "apply" },
      csrf: Csrf.layerConfig,
      ...(expose ? { openapiPath: "/openapi.json", docsPath: "/docs" } : {}),
    }),
  ),
).pipe(Layer.provide(Ports));

// 7. `HttpRouter.serve` binds a Node socket; `HttpRouter.toWebHandler` instead returns a portable
//    `(Request) => Promise<Response>` for tests and Fetch-native runtimes (Bun, Deno, Cloudflare Workers).
const ServerLive = HttpRouter.serve(AppLayer).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
);

Layer.launch(ServerLive).pipe(NodeRuntime.runMain);
