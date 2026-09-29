# Awthaq

*Effect Native Auth* — an authentication runtime for TypeScript, built natively on Effect v4, with authorization delegated to the sibling library [qadi](../qadi). The name comes from Arabic أوثق (*awthaq*, "most trustworthy/reliable") — the original working name, `effect-auth`, was already taken on npm by an abandoned package (see `research/01-effect-ecosystem.md`).

**Status:** actively implemented, pre-`1.0`/pre-publish. `spec/` is still the canonical specification — user requirements, architectural decisions, functional behaviors, invariants, and a traceability matrix tying them together — but it is no longer just a plan: every plugin below has a real, tested implementation under `packages/`. See [`spec/roadmap.md`](spec/roadmap.md) for the milestone plan and [`.scratch/shipping-gaps/map.md`](.scratch/shipping-gaps/map.md) for the most recent gap-closure pass against it.

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
| [`packages/`](packages) | The implementation: `core` (domain services), `api`/`server` (the HTTP contract stratum), `sql` (persistence), `ports` (adapters — password hashing, mail, encryption, rate limiting, WebAuthn, key management), and one package per plugin (`password`, `oauth`, `organization`, `admin`, `passkey`, `jwt`, plus stub packages not yet built out — see each package's own README). |
| [`features/`](features) | The Gherkin/BDD acceptance suite (`spec/behaviors/` scenarios, executed for real against each plugin's HTTP surface). |
| [`spec/`](spec/README.md) | The canonical specification. Read this first for *why* something is built the way it is. |
| [`research/`](research/README.md) | The evidence base: 100 design questions answered by domain research, plus a five-part literature review on plugin-system science. Cited from `spec/decisions/` and `spec/behaviors/` as supporting evidence — not itself normative. |
| [`better-auth/`](better-auth/README.md) | A Design-by-Contract analysis of better-auth, a competing framework, used as a comparison point throughout the research and decisions. |
| [`archive/`](archive/PRD.md) | The pre-`spec/` product requirements document and design series. Superseded; kept for historical and evidentiary record. |

## Quickstart

This is a single, complete, copy-pasteable server — no separate example app. It composes:

- the **Password** plugin (sign-up, sign-in) via `Auth.make`,
- the core **Session**/**Account** HTTP surface (list/revoke sessions, update profile, delete account) wired directly, since `Auth.make` composes plugin contracts and doesn't yet prepend the fixed core surface (`spec/roadmap.md`'s M1 Core milestone — see the note at the bottom of this section),
- a real, migrated **Postgres** backend via `@effect/sql-pg`,
- and a real listening HTTP server via `@effect/platform-node`.

Save this as `server.ts` inside a clone of this repository (it imports workspace packages by name, so it needs to run where those resolve — see [Publishing status](#publishing-status)):

```ts
import { createServer } from "node:http";
import { Auth, AuthEvents, RateLimits, Sessions, Users, Accounts, Verification } from "@awthaq/core";
import { CoreMigrations, Repositories } from "@awthaq/sql";
import { Encryption, KeyProvider, Mailer, PasswordHasher, RateLimiter } from "@awthaq/ports";
import { AuthCore } from "@awthaq/api";
import { Password } from "@awthaq/password";
import { Account, Authentication, AuthHttp, Session } from "@awthaq/server";
import { NodeCrypto, NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { Migrator } from "effect/unstable/sql";

// 1. Compose the Password plugin. `Auth.make` validates the plugin tuple at
//    the type level (no duplicate ids, no missing `dependsOn`) and folds
//    every plugin's own HttpApi contract and Layer into one `api`/`layer`
//    pair — here that's just Password, but the same call takes
//    `[Password, OAuth, Organization, Admin, Passkey, Jwt]` unchanged.
const auth = Auth.make([Password.Password]);

// 2. A real Postgres connection and a real, forward-only migration run —
//    the same `Migrator` and migration set `packages/sql`'s own contract
//    tests run against SQLite and Postgres alike.
const SqlLive = PgClient.layer({ url: Redacted.make(process.env.DATABASE_URL!) });
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

// 3. Provider tokens (OAuth access/refresh tokens) are encrypted at rest;
//    `KeyProvider.layerEnv` reads the key from `AWTHAQ_ENCRYPTION_KEY`
//    (base64, 32 bytes) even when no OAuth plugin is installed, since the
//    `accounts` table's encryption columns are shared, core-owned schema.
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
).pipe(Layer.provideMerge(SqlLive), Layer.provideMerge(Migrated));

// 4. The domain services, backed by those repositories instead of memory.
const CoreLive = Layer.mergeAll(
  Users.layerSql,
  Accounts.layerSql,
  Sessions.layerSql,
  Verification.layerSql,
).pipe(
  Layer.provideMerge(RepositoriesLive),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

// 5. Swap these ports for your own: a real mailer (SMTP/SES/Resend/...)
//    in place of this console stand-in, and — if you want breach
//    checking or a persistent rate-limit store — `PasswordHasher`'s and
//    `RateLimiter`'s other layers instead of the defaults below.
const consoleMailer = Layer.succeed(
  Mailer.Mailer,
  Mailer.Mailer.of({
    send: (message) => Effect.sync(() => console.log(`[mail] to=${message.to} subject=${message.subject}`)),
  }),
);

// 6. Mount both the plugin's own contract and the core Session/Account
//    contract onto the same router — `AuthHttp.routes` registers with
//    whatever `HttpRouter` is ambient, so merging two calls to it is all
//    that's needed to serve them together (no gateway/adapter layer).
const AppLayer = Layer.mergeAll(
  AuthHttp.routes(auth.api, { openapiPath: "/openapi.json" }).pipe(Layer.provide(auth.layer)),
  AuthHttp.routes(AuthCore.AuthCoreApi, {}).pipe(
    Layer.provide(Session.SessionHandlers),
    Layer.provide(Account.AccountHandlers),
  ),
  AuthHttp.docs(auth.api),
).pipe(
  Layer.provideMerge(AuthenticationLive),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(
    Layer.mergeAll(PasswordHasher.layerArgon2id, consoleMailer, RateLimiter.layerPermissive).pipe(
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

// 7. `HttpRouter.serve` is the same real serving path `AuthHttp.ts`'s own
//    header comment documents alongside `HttpRouter.toWebHandler` (used
//    instead in tests, and in any Fetch-native runtime — Bun, Deno,
//    Cloudflare Workers — since it returns a portable `(Request) =>
//    Promise<Response>` handler rather than binding a Node socket).
const ServerLive = HttpRouter.serve(AppLayer).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
);

Layer.launch(ServerLive).pipe(NodeRuntime.runMain);
```

> **Why `AuthHttp.routes(AuthCore.AuthCoreApi, {})` alongside `Auth.make`?** `Auth.make([Password])` folds Password's own `contract`/`layer` — the `/password/sign-up`, `/password/sign-in`, etc. routes — but awthaq's fixed, always-present core surface (`Session`: list/current/revoke/revokeOthers/signOut; `Account`: update profile, delete account) is not yet one of the things `Auth.make` prepends automatically (`packages/core/src/Auth.ts`'s own header comment: that lands with M1 Core, per `spec/roadmap.md`). Until then, wiring `AuthCore.AuthCoreApi` alongside a plugin's own `Auth.make(...)` output — exactly as this repository's own HTTP integration tests do — is the current, real way to get both.

Run migrations and start it:

```sh
export DATABASE_URL="postgres://user:pass@localhost:5432/awthaq"
export AWTHAQ_ENCRYPTION_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")"
node --experimental-strip-types server.ts
```

## Running it

```sh
curl -i -X POST http://localhost:3000/password/sign-up \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct horse battery staple"}'
# HTTP/1.1 200 OK
# set-cookie: __Host-session=...; Path=/; Secure; HttpOnly; SameSite=Lax
# {"id":"...","createdAt":"...","lastActiveAt":"...","expiresAt":"...","userAgent":null,"current":true}

curl -i -X POST http://localhost:3000/password/sign-in \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct horse battery staple"}'

curl -i -X PATCH http://localhost:3000/user \
  -H 'content-type: application/json' \
  -H 'cookie: __Host-session=<token from set-cookie above>' \
  -d '{"name":"Ada Lovelace"}'
# {"id":"...","email":"ada@example.com","emailVerified":false,"name":"Ada Lovelace"}

curl -i -X DELETE http://localhost:3000/user \
  -H 'cookie: __Host-session=<token>'
# HTTP/1.1 204 No Content
```

This exact composition — `Auth.make([Password])` over a real, migrated SQL backend, serving sign-up, sign-in, profile update, and account deletion through a real listening HTTP server — was run as a smoke test while writing this document (against an in-memory SQLite `SqlClient` locally, since `packages/sql`'s domain layers are dialect-agnostic and no local Postgres was available in that environment; CI's `postgres:16` service, per `.github/workflows/check.yml`, is the first real signal against Postgres itself specifically — the same caveat `packages/sql/test/Repositories.postgres.test.ts` documents for its own Postgres suite). Swapping `SqliteClient.layer({...})` for `PgClient.layer({ url })` is the only change between the two — `Users.layerSql`/`Accounts.layerSql`/`Sessions.layerSql`/`Verification.layerSql` never see which dialect is underneath.

## Swapping in Postgres for real

`packages/sql` ships one migration set (`CoreMigrations.coreMigrations`, in `@awthaq/sql`) that branches per dialect internally (`sql.onDialectOrElse`), so the same `Migrator.make({})({ loader: CoreMigrations.coreMigrations })` call in the quickstart above brings a fresh Postgres database to schema-equality with what `packages/sql/src/Models.ts` declares — no separate Postgres-specific schema file to maintain. See [`.scratch/shipping-gaps/issues/15-postgres-backend-migrations.md`](.scratch/shipping-gaps/issues/15-postgres-backend-migrations.md) for how this was proven (a dedicated contract-test suite runs against SQLite, then Postgres, with the same test bodies).

Plugin-specific tables (`Organization`, `Admin`, `Passkey`, `Jwt` each own their own schema in their own package) are not part of `CoreMigrations` — see each plugin's own package for its migrations.

## Configuration

Every port below has a memory/test-friendly layer and at least one real one; the quickstart above picks a reasonable real default for each:

| Port | Real layer used above | Other options |
|---|---|---|
| `PasswordHasher` | `layerArgon2id` | `layerScrypt` |
| `Mailer` | a one-line `console.log` stand-in | bring your own (`Mailer.Mailer.of({ send })`, any provider) |
| `RateLimiter` | `layerPermissive` (no real limiting) | `layer` over `layerStoreMemory`, or your own `RateLimiterStore` |
| `Encryption`/`KeyProvider` | `layerEnv` (`AWTHAQ_ENCRYPTION_KEY`) | a KMS-backed `KeyProvider` (implement the port directly) |
| `Csrf.CsrfConfig` | `Csrf.layerConfig` (`AWTHAQ_CSRF_SECRET`, at least 32 bytes; optional `AWTHAQ_CSRF_ALLOWED_ORIGINS`, comma-separated) | `Layer.succeed(Csrf.CsrfConfig, { secret, allowedOrigins })` with a secret loaded from your own secret store |

`Sessions.SessionConfig` (absolute/idle expiry, idle-refresh throttle) and `Password.config({...})` (breach checking, off by default) are `Context.Reference`s with defaults — override either with `Layer.succeed`/`Password.config(...)` only if the defaults documented in `packages/core/src/Sessions.ts`/`packages/password/src/Password.ts` don't fit.

## Plugins

| Plugin | Package | What it adds |
|---|---|---|
| Password | `@awthaq/password` | Sign-up, sign-in, password reset, email verification, change-password, optional breach checking |
| OAuth | `@awthaq/oauth` | Third-party provider sign-in and account linking |
| Organization | `@awthaq/organization` | Multi-tenant organizations, membership, roles |
| Admin | `@awthaq/admin` | Impersonation, session force-stop, admin session listing |
| Passkey | `@awthaq/passkey` | WebAuthn registration and authentication |
| Jwt | `@awthaq/jwt` | JWT issuance/verification for stateless callers |

Each composes into `Auth.make([...])` alongside Password exactly as shown in the quickstart — `Auth.make`'s own type-level `Validate<P>` rejects the tuple at compile time if a plugin's `dependsOn` isn't also in the list, or if two plugins share an id. `two-factor`, `magic-link`, `api-key`, `cli`, and `next` remain stub packages — see [`.scratch/shipping-gaps/map.md`](.scratch/shipping-gaps/map.md)'s "Out of scope" section for why they're deliberately not part of this pass.

## Publishing status

No `@awthaq/*` package is published to npm — every `package.json` in `packages/` is still `"private": true`. A provenance-publish workflow (`.github/workflows/release.yml`, npm OIDC trusted publishing, no stored tokens) is wired and ready per [`spec/process/definitions-of-done.md`](spec/process/definitions-of-done.md)'s gate 12, but going live needs a one-time, manual trusted-publisher registration on npmjs.com that no automation here can perform. Until then, use this library from a clone: `pnpm install && pnpm build`, then reference packages the way the quickstart above does, or `pnpm link` a package into another project.

## Documentation

- [`spec/README.md`](spec/README.md) — the canonical specification: requirements, decisions, behaviors, invariants, traceability.
- [`spec/roadmap.md`](spec/roadmap.md) — the milestone plan and what each milestone's done-criteria are.
- [`research/README.md`](research/README.md) — the evidence base behind `spec/`'s decisions.
- [`CHANGELOG.md`](CHANGELOG.md) — per-package release notes.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how the repository is organized, how to set up a development environment, and what's expected of a pull request. Security issues: see [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE)
