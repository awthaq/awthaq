// The application Layer the CLI builds for `seed admin` and `import`, for the suites: the real
// `Users`/`Accounts`/`AuthEvents`/`AuditLog`/`Roles`/`PasswordHasher` services over a real SQL
// client (SQLite), exactly what an application's `awthaq.config.ts` exports as `app`. It is a
// Layer over a `SqlClient` the *test* owns, so state survives across the separate builds each CLI
// invocation performs (a fresh runtime per command), the way a database does.
import { Accounts, AuditLog, AuthEvents, Hooks, Migrations, Slots, Users } from "@awthaq/core";
import { Encryption, KeyProvider, PasswordHasher, SqlTransaction } from "@awthaq/ports";
import { Roles } from "@awthaq/roles";
import { BetterAuthScryptVerifier } from "@awthaq/migrate-better-auth";
import { FirebaseScryptVerifier } from "@awthaq/migrate-firebase";
import { CoreMigrations, Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { role } from "@qadi/core";
import { passwordAndRoles } from "./TestApp.ts";

const adminRole = role({ name: "admin", permissions: [] });
const editorRole = role({ name: "editor", permissions: [] });

// `AccountsRepositoryLive` encrypts provider tokens at rest, so it needs `Encryption`; a fixed test
// key read through `ConfigProvider.fromEnv`, isolated from the real process environment.
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
  // `UserImport.importUser` runs each user in a `SqlTransaction` (nested inside the CLI's batch one).
  SqlTransaction.layerSql,
  // The imported better-auth / Firebase hashes verify through their legacy verifiers.
  PasswordHasher.layerArgon2id.pipe(
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(
      Layer.succeed(PasswordHasher.LegacyPasswordVerifiers, [
        BetterAuthScryptVerifier.betterAuthScryptVerifier,
        FirebaseScryptVerifier.firebaseScryptVerifier,
      ]),
    ),
  ),
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
);

/** Core services plus the Roles plugin (catalog: `admin`, `editor`) over the given SQL client. */
export const sqlApp = (sql: SqlClient.SqlClient) =>
  Roles.Roles.layerSql.pipe(
    Layer.provide(Roles.config([adminRole, editorRole])),
    Layer.provideMerge(CoreLive),
    // Exposed as well as provided: `import` keeps its checkpoint ledger on the application's own client.
    Layer.provideMerge(Layer.succeed(SqlClient.SqlClient, sql)),
    // The slot registry `Auth.make` would otherwise provide: `Roles` reads and overrides slots.
    Layer.provide(Slots.layer),
  );

/** The same without Roles: there is no administrative role concept to grant. */
export const sqlAppWithoutRoles = (sql: SqlClient.SqlClient) =>
  CoreLive.pipe(Layer.provideMerge(Layer.succeed(SqlClient.SqlClient, sql)));

/** Applies core's migrations and the composition's plugin migrations to the current client, as `migration apply --yes` does. */
export const migrate = Effect.gen(function* () {
  yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
  yield* Migrations.run(passwordAndRoles.migrations);
});
