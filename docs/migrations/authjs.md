# Migrating from Auth.js (NextAuth) to awthaq

No `@awthaq/migrate-authjs` package exists: every piece an Auth.js cutover needs is a port or a service that already ships, so this is a runbook, not a library. (If a second adopter appears, promote the recipe below to a package mirroring `@awthaq/migrate-better-auth`.) The goal is a cutover with **no forced global re-login and no password reset**.

Auth.js's database adapters share one schema shape (table and column casing varies by adapter; the Prisma names are used below):

| Auth.js | awthaq |
|---|---|
| `User` (`id`, `name`, `email`, `emailVerified`, `image`) | `users.create({ email, name })`, then `users.verifyEmail(id)` when `emailVerified` is set |
| `Account` (`provider`, `providerAccountId`, `access_token`, `refresh_token`, `expires_at`, `scope`, `token_type`) | `accounts.link({ providerId, subject, issuer, tokens })` |
| `Session` (`sessionToken`, `userId`, `expires`) | bridged (below), or dropped |
| `VerificationToken` (email-provider magic links) | not migrated — pending links simply expire |
| Credentials-provider password hash (your own column, usually bcrypt) | `accounts.link({ credentialHash })` + a legacy verifier |

awthaq assigns its own UUIDv7 user ids, so keep an `authjs user id → awthaq user id` map (or re-derive it by email) for your own application tables.

## 1. Users and OAuth accounts (ETL)

Run once per exported user against the composed `Users`/`Accounts` services. Mapping notes:

- `provider` → `providerId`; `providerAccountId` → `subject`.
- `issuer` is the third component of the identity anchor `(providerId, subject, issuer)` (BEH-EA-125). Use `""` for plain OAuth 2.0 providers and the provider's OIDC `iss` for OIDC providers — it must equal the issuer awthaq's OAuth plugin will see at sign-in, or the same person will not match their imported account.
- `expires_at` in Auth.js is **unix seconds**; awthaq's `ProviderTokenSet` takes `DateTime`s (`DateTime.makeUnsafe(expires_at * 1000)`).
- Tokens are encrypted at rest by `@awthaq/ports`' `Encryption` (AES-256-GCM, AAD bound to row and column); a bulk import therefore needs the deployment's `Encryption` layer.

```ts
import { Accounts, Users } from "@awthaq/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

const importOAuthAccount = (row: AuthJsUserWithAccount) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const accounts = yield* Accounts.Accounts;
    const created = yield* users.create({ email: row.email, name: row.name ?? row.email });
    const user = row.emailVerified === null ? created : yield* users.verifyEmail(created.id);
    yield* accounts.link({
      userId: user.id,
      providerId: row.provider,
      subject: row.providerAccountId,
      issuer: row.issuer ?? "",
      ...(row.access_token === null
        ? {}
        : {
            tokens: {
              accessToken: Redacted.make(row.access_token),
              refreshToken: Option.fromNullOr(row.refresh_token).pipe(Option.map(Redacted.make)),
              accessTokenExpiresAt: Option.fromNullOr(row.expires_at).pipe(
                Option.map((seconds) => DateTime.makeUnsafe(seconds * 1000)),
              ),
              refreshTokenExpiresAt: Option.none(),
              scope: Option.fromNullOr(row.scope),
              tokenType: Option.fromNullOr(row.token_type),
            },
          }),
    });
  });
```

`create` fails with `EmailAlreadyExists` and `link` with `AccountAlreadyLinked` on a re-run; a bulk script decides whether those mean "already migrated, skip". A user with several OAuth accounts is one `users.create` plus several `accounts.link` calls (group the export by email first).

## 2. Credentials-provider passwords

Auth.js's Credentials provider stores nothing itself; the hash is whatever your `authorize` callback compared against — most often bcrypt.

1. Import the account with the hash stored **verbatim**: `accounts.link({ userId, providerId: Accounts.PASSWORD_PROVIDER_ID, subject: userId, credentialHash: Redacted.make(hash) })`. `@awthaq/migrate-auth0`'s `ImportAuth0User.importUser({ email, name, emailVerified, passwordHash })` does exactly this and can be used as-is for any bcrypt export despite its name.
2. Install a legacy verifier next to your primary hasher, so `verify` recognizes the foreign format:

```ts
import { BcryptVerifier } from "@awthaq/migrate-auth0"; // recognizes $2a$/$2b$/$2y$ hashes
import { PasswordHasher } from "@awthaq/ports";
import * as Layer from "effect/Layer";

const HasherLive = PasswordHasher.layerArgon2id.pipe(Layer.provideMerge(BcryptVerifier.layer));
```

3. Rehash-on-login (`@awthaq/password`) upgrades each account to argon2id on that user's next successful sign-in; `hash()` never produces bcrypt. For a hash format other than bcrypt, implement `PasswordHasher.LegacyPasswordVerifierShape` (`recognizes` must be a cheap prefix test; `verify` does the KDF) and provide it through `PasswordHasher.LegacyPasswordVerifiers`.

## 3. Sessions

There are two cases, and the default is the honest one:

- **JWT strategy** (Auth.js's default without an adapter; the only strategy the Credentials provider supports). The cookie is an encrypted JWT keyed by `AUTH_SECRET`; awthaq cannot mint a session from it without re-implementing Auth.js's JWE. Users sign in again once. Nothing to configure.
- **Database strategy** (adapter default). The cookie value is the row's `sessionToken`, so a still-live session can be bridged into a fresh awthaq session with no re-login, using two pieces:

**a. Alias the cookie.** awthaq reads its own session cookie name. The generic `AliasLegacyCookieMiddleware` in `@awthaq/migrate-better-auth` (transport-only; it copies a legacy cookie's value onto the awthaq cookie when the latter is absent) works for any legacy cookie name:

```ts
import { AliasLegacyCookieMiddleware } from "@awthaq/migrate-better-auth";

// v5 over HTTPS: "__Secure-authjs.session-token"; v5 over HTTP: "authjs.session-token";
// v4: "next-auth.session-token" / "__Secure-next-auth.session-token".
const alias = AliasLegacyCookieMiddleware.make({ legacyCookieName: "__Secure-authjs.session-token" });
```

**b. Provide a `LegacySessionBridge`.** `Sessions.verify` consults it only on a primary-store miss (the legacy token is not an `id.secret`). `resolve` must return the **awthaq** user id, so the bridge maps the Auth.js user to the imported user by email; `consume` makes the legacy token single-use:

```ts
import { Users } from "@awthaq/core";
import { LegacySessionBridge } from "@awthaq/ports";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Models } from "@awthaq/sql"; // Models.dialectFields: Date on pg, ISO string on SQLite

// `sql` here must be a client pointed at the RETAINED, read-mostly Auth.js database —
// provide it to this layer separately from the awthaq database's own SqlClient.
export const AuthJsSessionBridge = Layer.effect(
  LegacySessionBridge.LegacySessionBridge,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const users = yield* Users.Users;
    const wire = Models.dialectFields(yield* Models.resolveDialect(sql));

    const find = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ email: Schema.String, expires: wire.dateTime }),
      execute: (token) => sql`
        SELECT u."email" AS email, s."expires" AS expires
        FROM "Session" s JOIN "User" u ON u."id" = s."userId"
        WHERE s."sessionToken" = ${token}`,
    });

    return LegacySessionBridge.LegacySessionBridge.of({
      resolve: (rawToken) =>
        Effect.gen(function* () {
          const row = yield* find(rawToken);
          if (Option.isNone(row)) return Option.none();
          const now = yield* DateTime.now;
          if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.value.expires)) {
            return Option.none(); // expired upstream: same answer as "unknown"
          }
          const user = yield* users.findByEmail(row.value.email);
          return Option.map(user, (u) => ({
            userId: u.id,
            ipAddress: Option.none<string>(),
            userAgent: Option.none<string>(),
          }));
        }).pipe(Effect.orElseSucceed(() => Option.none())),
      consume: (rawToken) =>
        sql`DELETE FROM "Session" WHERE "sessionToken" = ${rawToken}`.pipe(
          Effect.orElseSucceed(() => undefined),
        ),
    });
  }),
);
```

(The bridge cannot fail: any error degrades to "not a bridgeable session", which `Sessions.verify` reports as the ordinary uniform `SessionNotFound`.) With no bridge installed the port defaults to a no-op, and forced re-login is exactly what happens.

## 4. Callbacks: `signIn`, `jwt`, `session`

Auth.js's `callbacks` have direct landing spots. The sign-in ones are **hook points** (`@awthaq/core`'s `Hooks`, BEH-EA-089 to 096); a tap is a `Layer` provided next to the hook points' own layer (`Hooks.HooksLive`), and a veto's abort reaches the client as the typed `HookAborted` (HTTP 403) carrying your `code`.

| Auth.js callback | awthaq |
|---|---|
| `signIn` returns `true` | a `Hooks.BeforeSignIn` tap returns its input (or no tap at all) |
| `signIn` returns `false` | a `BeforeSignIn` tap fails with `new HookPoint.HookAbort({ code: "ACCESS_DENIED" })` |
| `signIn` returns a redirect path (a string) | fail with a `code` (and `message`) your client maps to that redirect; a hook cannot itself redirect a JSON API |
| `signIn` throws | the same as `false`: an unexpected defect in a tap is a 500, so translate business refusals into `HookAbort` |
| `events.createUser` / `events.signIn` | `Hooks.AfterSignUp` / `Hooks.AfterSignIn` taps (observe: a failure never fails the sign-in), or an `AuthEvents.on("auth.user.created" \| "auth.user.signedIn", ...)` subscriber |
| domain allow-list on first login (`signIn` checking `profile.email`) | a `Hooks.BeforeSignUp` tap: it is consulted on password sign-up **and** on OAuth first-login creation (`strategy` is `"password"` or the provider id) |
| `jwt` / `session` (add claims to the token or session object) | `@awthaq/qadi` attribute resolvers and `UserClaims`, not a token mutation: authorization reads attributes at decision time |

`BeforeSignIn` is consulted by every sign-in-completing flow (password, OAuth, passkey) after the credential is proven and before `BeforeSessionIssue` (the MFA divert point), so a denial can never be used to probe a guessed password. Its input is `{ userId, email, strategy }`:

```ts
import { HookPoint, Hooks } from "@awthaq/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const AllowCompanyDomain = Hooks.BeforeSignIn.tap((input) =>
  input.email.endsWith("@acme.com")
    ? Effect.succeed(input)
    : Effect.fail(new HookPoint.HookAbort({ code: "DOMAIN_NOT_ALLOWED" })),
).pipe(Layer.provideMerge(Hooks.HooksLive));
```

## 5. Cutover checklist

1. Provision awthaq (`CoreMigrations` for the core tables, `Migrations.run(auth.migrations)` for plugins — see `packages/sql/README.md`, *Running migrations*).
2. Import users, accounts and credential hashes (steps 1–2). Keep the Auth.js database read-only from here on.
3. Deploy with the hasher layer including `BcryptVerifier.layer`, and, for database-strategy sessions, the cookie alias and bridge (step 3).
4. Point traffic at awthaq. Existing bridged sessions are exchanged for real awthaq sessions on first use; everything else signs in again once.
5. After your longest session lifetime has passed, remove the bridge and the alias, and retire the Auth.js database.
