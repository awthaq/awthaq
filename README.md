# Awthaq

*Effect Native Auth* — an authentication runtime for TypeScript, built natively on Effect v4, with authorization delegated to the sibling library [qadi](../qadi). The name comes from Arabic أوثق (*awthaq*, "most trustworthy/reliable") — the original working name, `effect-auth`, was already taken on npm by an abandoned package (see `research/01-effect-ecosystem.md`).

**Status:** actively implemented, pre-`1.0`/pre-publish. `spec/` is still the canonical specification — user requirements, architectural decisions, functional behaviors, invariants, and a traceability matrix tying them together — but it is no longer just a plan: every plugin in [Plugins](#plugins) has a real, tested implementation under `packages/`, except `two-factor` and `magic-link`, which are placeholder packages with no exports yet. SAML (service provider only) and an OIDC provider are specified in `spec/`, not built (device authorization, RFC 8628, ships as `@awthaq/device-authorization`). See [`spec/roadmap.md`](spec/roadmap.md) for the milestone plan and what has shipped against it, and [`.scratch/shipping-gaps/map.md`](.scratch/shipping-gaps/map.md) for the most recent gap-closure pass.

No package is published to npm yet (`packages/*/package.json` are all still `"private": true` — see [Publishing status](#publishing-status)). This quickstart runs the library from a clone of this repository.

## Contents

- [Repository map](#repository-map)
- [Quickstart](#quickstart)
- [Running it](#running-it)
- [Swapping in Postgres for real](#swapping-in-postgres-for-real)
- [Configuration](#configuration)
- [Plugins](#plugins)
- [Publishing status](#publishing-status)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Repository map

| Path | What it is |
|---|---|
| [`packages/`](packages) | The implementation, one package per `@awthaq/*` name. Foundations: `@awthaq/core` (domain services), `@awthaq/api` and `@awthaq/server` (the HTTP contract stratum), `@awthaq/sql` (persistence), `@awthaq/ports` (adapters — password hashing, mail, encryption, rate limiting, WebAuthn, key management), `@awthaq/qadi` (authorization over qadi) and `@awthaq/test` (the memory backend and test harness). Plugins: `@awthaq/password`, `@awthaq/oauth`, `@awthaq/organization`, `@awthaq/roles`, `@awthaq/admin`, `@awthaq/passkey`, `@awthaq/jwt`, `@awthaq/api-key`, `@awthaq/scim`, `@awthaq/device-authorization`, plus `@awthaq/magic-link` and `@awthaq/two-factor` (placeholders not yet built out). Clients: `@awthaq/client`, `@awthaq/react`, `@awthaq/next`. Tooling: `@awthaq/cli` and the migration importers `@awthaq/migrate-auth0`, `@awthaq/migrate-better-auth`, `@awthaq/migrate-firebase`. Each package's own README says what it ships. `pnpm workspace:check` fails when this list falls behind `packages/`. |
| [`examples/`](examples) | Runnable compositions: [`memory-server`](examples/memory-server/README.md) (Password + Organization + Roles over the memory backend, no database), [`sql-server`](examples/sql-server/README.md) (Password over a real, migrated SQL backend: a SQLite file by default, Postgres when `DATABASE_URL` is set) and [`plugin-template`](examples/plugin-template) (the plugin [`docs/plugin-authoring.md`](docs/plugin-authoring.md) walks through). |
| [`docs/`](docs) | Guides: [plugin authoring](docs/plugin-authoring.md) and [migrations](docs/migrations). |
| [`features/`](features) | The Gherkin/BDD acceptance suite (`spec/behaviors/` scenarios, executed for real against each plugin's HTTP surface). |
| [`spec/`](spec/README.md) | The canonical specification. Read this first for *why* something is built the way it is. |
| [`research/`](research/README.md) | The evidence base: 100 design questions answered by domain research, plus a five-part literature review on plugin-system science. Cited from `spec/decisions/` and `spec/behaviors/` as supporting evidence — not itself normative. |
| [`better-auth/`](better-auth/README.md) | A Design-by-Contract analysis of better-auth, a competing framework, used as a comparison point throughout the research and decisions. |
| [`archive/`](archive/PRD.md) | The pre-`spec/` product requirements document and design series. Superseded; kept for historical and evidentiary record. |

## Quickstart

> **No database handy?** [`examples/memory-server`](examples/memory-server/README.md) runs Password, Organization and Roles over the memory backend with no `DATABASE_URL`, no migration and no keys (`pnpm install`, then `node --experimental-strip-types index.ts` inside it; it listens on `:3001`). Its walkthrough completes a sign-in the same way this one does, with the development mailer. [`examples/sql-server`](examples/sql-server/README.md) is this quickstart as a runnable, tested app over a SQLite file (Postgres by setting `DATABASE_URL`): the one-layer swap between the two.

This is a single, complete, copy-pasteable server — no separate example app. The code block below is compiled by `pnpm typecheck` (`packages/sql/test/fixtures/readme-quickstart.ts`, kept identical to it by `packages/sql/test/ReadmeQuickstart.test.ts`), so it cannot drift from the API. It composes:

- the **Password** plugin (sign-up, sign-in) via `Auth.make`,
- the core **Session**/**Account** HTTP surface (list/revoke sessions, update profile, delete account), which `Auth.make(...).api` always carries beside the plugins' groups (its handlers are `AuthHttp.coreHandlers` — see the note at the bottom of this section),
- a real, migrated **Postgres** backend via `@effect/sql-pg`, its URL read through Effect's `Config` (`DATABASE_URL`),
- the cross-cutting services the core flows need (hook points, account erasure and export, the audit log, CSRF protection, a client-address resolver, one SQL transaction domain),
- and a real listening HTTP server via `@effect/platform-node`.

Save this as `server.ts` inside a clone of this repository (it imports workspace packages by name, so it needs to run where those resolve — see [Publishing status](#publishing-status)):

```ts
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
```

> **Where do the Session/Account routes come from?** `Auth.make` seeds `api` with core's own `session` and `account` groups (`AuthCore.AuthCoreApi`), then any `extraGroups` you pass (`Auth.make([...], { extraGroups: [SubjectApi.SubjectGroup] })` for `@awthaq/qadi`'s subject endpoint; you provide their handlers), then every plugin's groups: one served document, with a plugin that reuses a core group id or route refused at composition. Serving `auth.api` without `AuthHttp.coreHandlers` fails at layer build rather than answering 404.

Run migrations and start it:

```sh
export DATABASE_URL="postgres://user:pass@localhost:5432/awthaq"
export AWTHAQ_ENCRYPTION_KEYS="[{\"kid\":\"k1\",\"key\":\"$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")\"}]"
export AWTHAQ_ENCRYPTION_KEY_ID="k1"
export AWTHAQ_CSRF_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")"
node --experimental-strip-types server.ts
```

## Running it

Every unsafe request (`POST`, `PATCH`, `DELETE`) is CSRF-protected: it must echo the `__Host-csrf` cookie in an `x-csrf-token` header (a request carrying an `Authorization` header is exempt). Any response from a protected group sets that cookie, so fetch one first. The development mailer in the quickstart (`Mailer.layerConsole`) logs each message, including the verification token (`token=verify-email:...`), to the server's stdout; `sign-in` refuses (`403 EmailNotVerified`) until that token is posted to `/verify-email`.

```sh
BASE=http://localhost:3000
PASSWORD='kettle-orbit-lantern-92-plover'   # sign-up screens against known breaches, so avoid famous passphrases
CSRF=$(curl -si $BASE/session | tr -d '\r' | grep -i '^set-cookie: __Host-csrf' | sed -E 's/^[^=]*=([^;]+);.*/\1/')

curl -i -X POST $BASE/password/sign-up \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" -H "cookie: __Host-csrf=$CSRF" \
  -d "{\"email\":\"ada@example.com\",\"password\":\"$PASSWORD\"}"
# HTTP/1.1 200 OK
# set-cookie: __Host-session=...; Max-Age=2591999; Path=/; HttpOnly; Secure; SameSite=Strict
# {"id":"...","createdAt":"...","lastActiveAt":"...","expiresAt":"...","userAgent":"curl/...","amr":["pwd"],"current":true}

# the server log now shows an 'awthaq mail' line with template=verify-email and the token
curl -i -X POST $BASE/verify-email \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" -H "cookie: __Host-csrf=$CSRF" \
  -d '{"token":"<token from the server log>"}'
# HTTP/1.1 204 No Content

curl -i -X POST $BASE/password/sign-in \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" -H "cookie: __Host-csrf=$CSRF" \
  -d "{\"email\":\"ada@example.com\",\"password\":\"$PASSWORD\"}"
# HTTP/1.1 200 OK, with a fresh __Host-session cookie

curl -i -X PATCH $BASE/user \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -H "cookie: __Host-csrf=$CSRF; __Host-session=<token from set-cookie above>" \
  -d '{"name":"Ada Lovelace"}'
# {"id":"...","identity":{"_tag":"Email","email":"ada@example.com","emailVerified":true},"name":"Ada Lovelace","image":null}

curl -i -X DELETE $BASE/user \
  -H "x-csrf-token: $CSRF" -H "cookie: __Host-csrf=$CSRF; __Host-session=<token>"
# HTTP/1.1 204 No Content
```

The session cookie is `SameSite=Strict` (BEH-EA-055), so a browser does not send it on a cross-site top-level navigation. The provider's redirect back to the OAuth callback is exactly such a navigation, so the OAuth plugin correlates it with its own ten-minute `SameSite=Lax` `__Host-oauth-state` cookie (`packages/oauth/src/OAuth.ts`; an opaque correlation value, the flow state itself lives server-side) rather than with the session cookie.

This exact composition was run end to end against an in-memory SQLite `SqlClient` while writing this section (sign-up, verify, sign-in, profile update, export and delete all answered as shown; with `AWTHAQ_EXPOSE_DOCS` unset, `/openapi.json` and `/docs` answered `404`). `packages/sql`'s domain layers are dialect-agnostic, so swapping `PgClient.layerConfig({ url })` for `SqliteClient.layer({ filename })` is the only change between the two; CI's `postgres:16` service (`.github/workflows/check.yml`) is the signal against Postgres itself, the same caveat `packages/sql/test/Repositories.postgres.test.ts` documents. Nothing here has been run against a real Postgres by hand.

## Swapping in Postgres for real

`packages/sql` ships one migration set (`CoreMigrations.coreMigrations`, in `@awthaq/sql`) that branches per dialect internally (`sql.onDialectOrElse`), so the same `Migrator.make({})({ loader: CoreMigrations.coreMigrations })` call in the quickstart above brings a fresh Postgres database to schema-equality with what `packages/sql/src/Models.ts` declares — no separate Postgres-specific schema file to maintain. See [`.scratch/shipping-gaps/issues/15-postgres-backend-migrations.md`](.scratch/shipping-gaps/issues/15-postgres-backend-migrations.md) for how this was proven (a dedicated contract-test suite runs against SQLite, then Postgres, with the same test bodies).

Plugin-specific tables (`Organization`, `Admin`, `Passkey`, `Jwt`, `ApiKey`, `Scim` each own their own schema in their own package) are not part of `CoreMigrations` — see each plugin's own package for its migrations.

## Configuration

Every port below has a memory/test-friendly layer and at least one real one; the quickstart above picks a reasonable real default for each:

| Port | Real layer used above | Other options |
|---|---|---|
| `PasswordHasher` | `layerArgon2id` | `layerScrypt`; `PasswordHasherWorkerPool.layerArgon2id`/`layerScrypt` run the KDF in worker threads (Node), see [Password hashing](#password-hashing) |
| `Mailer` | `Mailer.layerConsole`, a development mailer that logs the verification token (never in production: the token is a credential) | bring your own (`Mailer.Mailer.of({ send, sent })`, any provider); `Mailer.layerMemory` records mail for tests |
| `RateLimiter` | `layer` over `RateLimiterStoreSql.layerStoreSql` (shared across replicas) | `RateLimiter.layerMemory` (the bounded, single-process store in one line — the default when you have one instance), or `layer` over your own `RateLimiterStore`; `layerPermissive` disables limiting and logs a warning when a rule runs against it (tests only) |
| `Encryption`/`KeyProvider` | `layerEnv` (`AWTHAQ_ENCRYPTION_KEYS` + `AWTHAQ_ENCRYPTION_KEY_ID`) | a KMS-backed `KeyProvider` (implement the port directly; keeps raw key bytes out of the process); `KeyProvider.layerEphemeral` (dev only: a random key per run, logged loudly, refused under `NODE_ENV=production` unless `AWTHAQ_ALLOW_EPHEMERAL_KEY=true`; encrypted data does not survive a restart) |
| `Csrf.CsrfConfig` | `Csrf.layerConfig` (`AWTHAQ_CSRF_SECRET`, at least 32 bytes; optional `AWTHAQ_CSRF_ALLOWED_ORIGINS`, comma-separated) | `Layer.succeed(Csrf.CsrfConfig, { secret, allowedOrigins })` with a secret loaded from your own secret store |

### OpenAPI and the docs UI

`AuthHttp.docs` serves a Scalar UI and `AuthHttp.routes(api, { openapiPath })` serves the OpenAPI document (BEH-EA-084); both are unauthenticated. The quickstart therefore mounts them only when `AWTHAQ_EXPOSE_DOCS=true`. A production composition should omit `AuthHttp.docs` or put it behind its own authentication, and can export the document offline with `awthaq openapi` (BEH-EA-205).

### Password hashing

Hashing is CPU-heavy by design. The default layers run hash-wasm on the calling thread and bound it: at most `AUTH_PASSWORD_HASH_CONCURRENCY` (default 4) hashes in flight, and legacy verifiers such as bcrypt take a permit too. Each argon2id hash at the defaults (`AUTH_ARGON2_MEMORY_KIB=19456`, `AUTH_ARGON2_ITERATIONS=2`) takes tens of milliseconds and about 19 MiB; scrypt at `AUTH_SCRYPT_COST_LOG2=17` uses about 128 MiB, so peak KDF memory is roughly the concurrency times that.

On Node, offload the KDF entirely with one Layer swap so hashing never blocks the event loop:

```ts
import { PasswordHasherWorkerPool } from "@awthaq/ports";
import * as NodeWorker from "@effect/platform-node/NodeWorker";
import { Worker } from "node:worker_threads";

const HasherLive = PasswordHasherWorkerPool.layerArgon2id.pipe(
  Layer.provide(NodeWorker.layer(() => new Worker(PasswordHasherWorkerPool.workerEntry))),
);
```

`AUTH_PASSWORD_HASH_WORKER_POOL_SIZE` (default 4) sets the number of workers, one hash each at a time. Hashes are identical across both families, so switching is safe on live data.

Where to run it: password hash/verify belongs on your origin (long-running) runtime. A verify at the default cost is tens of milliseconds of CPU, above a Cloudflare Workers free-tier budget; let the edge tier verify sessions/JWTs and redirect. There is deliberately no cheaper "edge" storage profile.

Crypto on an edge runtime: the quickstart provides `NodeCrypto.layer` for `Crypto.Crypto`, which does not exist on Workers/Edge. Provide `WebCrypto.layer` from `@awthaq/ports` in its place — the same service over `globalThis.crypto` (`randomBytes`, SHA-1/256/384/512 digests), no Node built-ins. NodeCrypto stays the right choice on Node.

### Encryption keys

`AWTHAQ_ENCRYPTION_KEYS` is a JSON array of `{ "kid", "key" }` (`key` is base64 of exactly 32 bytes, kids unique); `AWTHAQ_ENCRYPTION_KEY_ID` names the entry new ciphertext is written under and must appear in the array. Both are validated when the layer is built. An older single `AWTHAQ_ENCRYPTION_KEY` deployment migrates by wrapping its value: `[{"kid":"env","key":"<old value>"}]` with `AWTHAQ_ENCRYPTION_KEY_ID=env`.

To rotate: add a new entry, point `AWTHAQ_ENCRYPTION_KEY_ID` at it, and keep the old entry. Existing ciphertext stays readable under the old key and is re-encrypted under the new one the next time it is read. Remove the old entry only once nothing written under it remains (retirement, not a timer; see `spec/decisions/019-encryption-key-rotation.md`). Raw key bytes cannot be scrubbed from a JS process; deployments that must not hold them in memory should implement `KeyProvider` over a KMS.

`Sessions.SessionConfig` (absolute/idle expiry, idle-refresh throttle) and `Password.config({...})` (breach screening, on by default and fail-open; `signUpEnumeration`, `requireVerifiedEmail`, ...) are `Context.Reference`s with defaults — override either with `Layer.succeed`/`Password.config(...)` only if the defaults documented in `packages/core/src/Sessions.ts`/`packages/password/src/Password.ts` don't fit.

### Running more than one replica

Every `layerMemory` in this repository (`Users`, `Accounts`, `Sessions`, `Verification`, `AuditLog`, `RevocationStore`, `SigningKeyRecords`, `ChallengeStore`, `RateLimiter.layerMemory`) is one `Ref` per process, so a second instance behind a load balancer would see a different world. To run replicas, the following must be identical or shared across all of them:

| What | How to share it |
|---|---|
| Domain state: users, accounts, sessions, verification tokens, the audit log | The `layerSql` variants over one database (`Users.layerSql`, `Accounts.layerSql`, `Sessions.layerSql`, `Verification.layerSql`, `AuditLog.layerSql`); a session revoked on one replica is then revoked on all |
| Encryption keyset (provider tokens, `users.metadata`) | The same `AWTHAQ_ENCRYPTION_KEYS` and `AWTHAQ_ENCRYPTION_KEY_ID` on every replica, or one KMS-backed `KeyProvider`; rotate by adding the new entry everywhere before pointing `AWTHAQ_ENCRYPTION_KEY_ID` at it (`spec/decisions/019-encryption-key-rotation.md`) |
| CSRF secret | The same `Csrf.CsrfConfig` secret (at least 32 bytes) and `allowedOrigins`; a token minted by one replica must verify on another |
| JWT signing keys, token denylist | `SigningKeyRecords.layerSql` and `RevocationStore.layerSql` (keys live in the database; private key material at rest is encrypted through `Encryption`), the same `JwtConfig`; rotation follows `spec/decisions/017-jwt-signing-key-rotation.md` |
| Rate limits | `RateLimiter.layer` over `RateLimiterStoreSql.layerStoreSql`; `RateLimiter.layerMemory` limits per replica, so the effective budget is multiplied by the replica count |
| Passkey ceremonies | `ChallengeStore.layerSql` (or the signed `layerCookie`), never `layerMemory`: the begin and finish requests may land on different replicas |

Two things are deliberately per process: `AuthEvents` subscribers (the in-process event bus; the durable record is the `AuditLog` table) and, when you configure one, a read replica (opt-in per read and guarded by a causal token, `spec/decisions/024-read-replica-routing.md`). The password-hashing worker pool is sized per replica (`AUTH_PASSWORD_HASH_WORKER_POOL_SIZE`).

### Cross-origin SPAs (CORS)

awthaq ships no CORS by default: a browser on another origin cannot read any response (same-origin, default-deny). To serve a separate SPA origin, merge `AuthHttp.cors()` into the same layer list as `AuthHttp.routes(...)`. Its allowlist is `CsrfConfig.allowedOrigins`, the value CSRF's `Origin` check already uses, so the two cannot drift:

```ts
const AppLayer = Layer.mergeAll(
  AuthHttp.routes(auth.api, {}).pipe(Layer.provide(AuthHttp.coreHandlers), Layer.provide(auth.layer)),
  AuthHttp.cors(), // reads CsrfConfig.allowedOrigins, e.g. ["https://app.example.com"]
);
```

CORS never relaxes CSRF: cross-site mutations still need the double-submit cookie and `x-csrf-token` header, which the SPA must send with `credentials: "include"`.

### Observability

awthaq reuses Effect's HTTP middleware and adds spans, a field vocabulary and metric definitions below it; the sinks (a log format, an OTLP/Prometheus exporter) are yours (`spec/decisions/032-observability-substrate.md`).

- **Requests.** `HttpRouter.serve` already writes one structured log line per request. If you serve through `toWebHandler`, or want a span per request, wrap the app once: `AuthHttp.tracer(AuthHttp.requestLogger(app))` (a host that already runs its own tracer/logger over the whole router must not add these). Merge `AuthHttp.layerRedactedHeaders` so the rotated-token header is never logged, and `RequestContext.layer` (a global router middleware, like `BodyLimit.layer`) so every audit row a request causes carries its correlation id (`x-request-id`, else the W3C trace id), client address and user agent.
- **Spans** are named `awthaq.<domain>.<operation>` (`awthaq.session.verify`, `awthaq.password.signIn`, `awthaq.hook.dispatch`, `awthaq.event.publish`, ...) and carry ids only: a user id, a valid session's id, the strategy. Never an email, password or token.
- **Metrics** are plain `Metric` values exported from `@awthaq/core`'s `Observability` (`sessionsIssued`, `sessionVerifyFailures`, `loginFailures`, `eventsDropped`, ...); wire them to your exporter.
- **Logs**: `Logger.layer([Logger.consoleJson])` in production, `Logger.consolePretty()` in development (see `examples/memory-server`). A failing subscriber or hook tap is logged as `auth.event.observer.error` / `auth.hook.observer.error` with a sanitized summary; the raw cause only at debug level.
- **Testing**: `TestAuth.layer` installs a `RedactionGuard` (in `@awthaq/test`) that records every span, log line and event; `runPluginContractTests`' `redaction` option runs a plugin's flows with canary secrets and fails if one reaches any of them.

### Erasing an account (GDPR Art. 17)

`DELETE /user` calls core's `Erasure.AccountErasure.eraseAccount(userId)`, which an admin console or a job can call directly. It runs the `BeforeUserDelete` veto first (a legal hold), then, in **one transaction**, every plugin's registered erasure (`Organization`, `Passkey`, `Roles` and `UserClaims` ship one), the core rows (accounts, sessions, verification tokens, the user) and the pseudonymization of every audit row that names the user, and only after the commit publishes `auth.user.deleted`. A plugin that stores personal data contributes with `AuthPlugin.layer(Self, { contributes: Erasure.contribute({ id, make }) })`; the layer requires `Erasure.ErasureRegistry` (part of `Hooks.HooksLive`), so leaving it out does not compile. Set `Erasure.config({ auditLog: "retain" })` to keep audit rows verbatim under a legal-obligation basis. The schema has no foreign keys by design, so no database cascade does this for you; the admin impersonation ledger is retained on purpose (`spec/decisions/031-erasure-registry-and-retention.md`).

### Delivering events to other services

`AuthEvents` is an in-process, bounded, at-most-once bus: right for a subscriber in the same process (`AuthEvents.on([...tags], handler)` in your composition; the subscription is registered before the layer is up, so nothing published after it is lost), wrong for another service, since a burst can be dropped and nothing crosses a process boundary. For those, use the outbox: every event is already a durable `AuditLog` row, and `EventRelay.layer({ name: "billing" })` tails that table from a persisted position into an `EventTransport` you provide (Redis, Kafka, SQS, an HTTP call: `{ deliver: (events) => Effect }`). It advances only after `deliver` succeeds, so delivery is at-least-once (deduplicate on `eventId`), retried with backoff, and resumes after a restart; provide `EventRelay.layerCursorSql` for a durable position (core migration 27) or `layerCursorMemory` for tests. An event is relayed once it is `settleDelay` old (default 2 s) so a row committed late by another process is not skipped; give each consumer its own `name`. For HTTP receivers, the opt-in `@awthaq/webhooks` plugin is that consumer, built and signed for you: register endpoints through its admin API (secret shown once, stored sealed), compose `Webhooks.Webhooks.background()` with a `RelayCursorStore`, an `HttpClient`, a `HostResolver` and an `Encryption`, and every matching event is queued per endpoint and POSTed with Standard-Webhooks `webhook-id` / `-timestamp` / `-signature` headers (retry with backoff, dead-letter, a delivery log; `WebhookSignature.verify` for receivers). See [`packages/webhooks/README.md`](packages/webhooks/README.md) and `spec/decisions/030-event-delivery-outbox-relay.md`.

### Detecting attacks

The library publishes its breach signals (`auth.session.reuse`, `auth.passkey.counterAnomaly`, `auth.token.replay`, `auth.user.signInFailed`, `auth.admin.impersonationDenied`); compose `SecuritySignals.layer` to act on them. It raises an incident (a `warning` log, `awthaq_security_incident_total{rule}`, and the `IncidentSink` you provide, e.g. a table or a pager) when a rule's threshold is reached inside its window; the defaults are one session reuse or passkey counter anomaly, 5 token replays per identifier, 10 failed sign-ins per address or 5 per identifier in ten minutes, and 3 denied impersonations per admin. Replace them with `SecuritySignals.config({ rules })`. It is opt-in and detection only: it never blocks a request (rate limits and hooks do that).

### Exporting an account (GDPR Art. 15/20)

`GET /user/export` (authenticated, rate limited to five an hour per account) downloads one JSON document, `account-export.json`: the user, linked accounts (provider and subject, never a hash or token), live sessions, the person's own audit activity, and one section per plugin that stores personal data under its plugin id (`Organization`, `Passkey`, `Roles` and `UserClaims` ship one). It contains no secret and nothing about anyone else, a plugin that cannot read its store fails the whole export rather than omit it, and each export is audited as `auth.user.dataExported`. A plugin contributes with `DataExport.contribute` beside its `Erasure.contribute`; `DataExport.AccountExport.exportAccount(userId)` is the same assembly for an admin console or a support script. A composition running `Account.AccountHandlers` provides `DataExport.layer` next to `Erasure.layer`, and a `RateLimiter` (`TestAuth.layer` already does).

### Retention

Expiry is a read-time rejection, so expired rows stay until something deletes them. `Retention.sweep` (`@awthaq/core`) does, in bounded batches, in both the memory and SQL layers: sessions more than `sessionGrace` (default 7 days) past their expiry, verification tokens and reservations more than `verificationForensicWindow` (default 90 days) past theirs, and audit rows only if you configure a window (`Retention.config({ auditLog: { default: Option.some(Duration.days(365)), rules: [{ tags: ["auth.user.signInFailed"], keepFor: Duration.days(90) }] } })`; the default keeps the trail for ever). Nothing runs it unless you do: call `sweep` from your own job, or provide `Retention.layerScheduled` (sweeps at start-up, then every `sweepInterval`, default 1 day). The defaults are a policy to confirm for your jurisdiction. The impersonation ledger is never purged (`spec/decisions/031-erasure-registry-and-retention.md`).

## Plugins

| Plugin | Package | What it adds |
|---|---|---|
| Password | `@awthaq/password` | Sign-up, sign-in, password reset, email verification, change-password, optional breach checking |
| OAuth | `@awthaq/oauth` | Third-party provider sign-in and account linking |
| Passkey | `@awthaq/passkey` | WebAuthn registration and authentication |
| Jwt | `@awthaq/jwt` | JWT issuance/verification for stateless callers, JWKS with key rotation, a lite verifier for downstream services |
| ApiKey | `@awthaq/api-key` | Long-lived API keys and `client_credentials` service tokens |
| Organization | `@awthaq/organization` | Multi-tenant organizations, membership, invitations, teams, roles |
| Roles | `@awthaq/roles` | Role assignment flattened through qadi's role DAG into the `AuthSubject`'s roles and permissions (overrides qadi's `SubjectResolver` slot); memory and SQL persistence |
| Admin | `@awthaq/admin` | Impersonation, session force-stop, user and tenant administration |
| SCIM | `@awthaq/scim` | Inbound SCIM 2.0 provisioning: directory sync of users and groups, deactivation ends sessions |
| SAML | `@awthaq/saml` | SAML 2.0 service provider (SP only): SP-initiated login through an organization's own IdP, hardened XML-signature verification (`XmlSignature` port over `xml-crypto`) |
| Webhooks | `@awthaq/webhooks` | Opt-in signed outbound webhooks over the event relay: per-endpoint filters, retry/backoff/dead-letter, SSRF-safe endpoints, admin API |

Each composes into `Auth.make([...])` alongside Password exactly as shown in the quickstart — `Auth.make`'s own type-level `Validate<P>` rejects the tuple at compile time if a plugin's `dependsOn` isn't also in the list, or if two plugins share an id. `two-factor` and `magic-link` are placeholder packages with no exports; see [`.scratch/shipping-gaps/map.md`](.scratch/shipping-gaps/map.md)'s "Out of scope" section for why they are not part of that pass.

### Around the plugins

These are not `AuthPlugin`s; they sit beside the composition.

| Package | What it is |
|---|---|
| `@awthaq/qadi` | The bridge to [qadi](../qadi): the `AuthorizedSubject` middleware (Path A), the `SubjectExtractor` layer (Path B), attribute and relationship resolvers, obligation handlers. awthaq itself makes no authorization decision. |
| `@awthaq/client` | `HttpApiClient` bindings for the awthaq contract: CSRF client middleware, error-code derivation, a session store, a Promise facade, a passkey ceremony helper. |
| `@awthaq/react` | Reactive `AtomHttpApi` clients and `Providers` (session, subject and qadi gates in one atom registry). |
| `@awthaq/next` | Next.js adapter: database-verified `getSession`, the optimistic `proxy.ts` cookie check `hasSessionCookie`, and `withNextCookies` to bridge `Set-Cookie` from server actions. |
| `@awthaq/test` | `TestAuth` (the whole pipeline over memory) and `runPluginContractTests`. |
| `@awthaq/cli` | The `awthaq` command: `doctor`, `config list`, `plugin list --graph`, `routes`, `migration status|apply`, `openapi`, `seed admin`, `import`, `login`. |

### Migrating users from another provider

Each package lets imported users keep their password: it verifies the old hash on their first sign-in and `rehashOnLogin` upgrades it to argon2id.

| Source | Package | Hash it verifies |
|---|---|---|
| Auth0, Supabase (GoTrue) | `@awthaq/migrate-auth0` | bcrypt (`$2a$`/`$2b$`/`$2y$`) |
| Firebase Authentication | `@awthaq/migrate-firebase` | Firebase's modified scrypt |
| better-auth | `@awthaq/migrate-better-auth` | better-auth's scrypt (`salt:key`), plus live-session bridging |

## Publishing status

No `@awthaq/*` package is published to npm — every `package.json` in `packages/` is still `"private": true`. A provenance-publish workflow (`.github/workflows/release.yml`, npm OIDC trusted publishing, no stored tokens) is wired and ready per [`spec/process/definitions-of-done.md`](spec/process/definitions-of-done.md)'s gate 12, but going live needs a one-time, manual trusted-publisher registration on npmjs.com that no automation here can perform. Until then, use this library from a clone: `pnpm install && pnpm build`, then reference packages the way the quickstart above does, or `pnpm link` a package into another project.

## Documentation

- [`spec/README.md`](spec/README.md) — the canonical specification: requirements, decisions, behaviors, invariants, traceability.
- [`spec/roadmap.md`](spec/roadmap.md) — the milestone plan and what each milestone's done-criteria are.
- [`docs/plugin-authoring.md`](docs/plugin-authoring.md) — writing a plugin, with a tested template in [`examples/plugin-template`](examples/plugin-template).
- [`research/README.md`](research/README.md) — the evidence base behind `spec/`'s decisions.
- [`CHANGELOG.md`](CHANGELOG.md) — per-package release notes.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how the repository is organized, how to set up a development environment, and what's expected of a pull request. Security issues: see [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE)
