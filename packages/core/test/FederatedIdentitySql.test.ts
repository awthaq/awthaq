// ADR-EA-043, BEH-EA-338 over a real transaction: the same cases `FederatedIdentity.test.ts` runs over memory
// (`support/federatedIdentitySuite.ts`) run here over SQLite, and over Postgres under `pnpm test:pg`
// (`packages/test/src/TestSql.ts`), plus the cases that are only real with a rollback: a lost create leaves
// one user, one account and one announcement, and a lost resolve nested in an outer transaction recovers.
import * as TestEncryption from "../../test/src/TestEncryption.ts";
import * as TestSql from "../../test/src/TestSql.ts";
import { Encryption, KeyProvider, SqlTransaction } from "@awthaq/ports";
import { CoreMigrations, Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Accounts from "../src/Accounts.ts";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as FederatedIdentity from "../src/FederatedIdentity.ts";
import * as Persistence from "../src/Persistence.ts";
import * as Sessions from "../src/Sessions.ts";
import * as Users from "../src/Users.ts";
import {
  countOf,
  decorate,
  type EnvOptions,
  identity,
  suite,
  tap,
  withEmail,
  withoutEmail,
} from "./support/federatedIdentitySuite.ts";

/** Every SQL store over the ambient `SqlClient` (plan 02): provide it where the composition is built. */
const SqlStores = Persistence.sql().pipe(Layer.provide(TestEncryption.layer));

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

const SqlLive = TestSql.layer("core_FederatedIdentitySql");
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

const base = Layer.mergeAll(
  Users.layer.pipe(Layer.provide(SqlStores)),
  Accounts.layer
    .pipe(Layer.provide(SqlStores))
    .pipe(Layer.provide(Repositories.AccountsRepositoryLive.pipe(Layer.provide(EncryptionLive)))),
  Sessions.layer.pipe(Layer.provide(SqlStores)),
  SqlTransaction.layerSql,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(SqlStores))),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const env = (options: EnvOptions = {}) =>
  Layer.provideMerge(tap(options), Layer.provideMerge(decorate(options), base));

suite("sql", env);

const rows = (table: "users" | "accounts") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const counted = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT COUNT(*) AS n FROM ${table}`,
    );
    return Number(counted[0]?.["n"]);
  });

describe("FederatedIdentity over a real transaction", () => {
  it.effect(
    "a create race leaves one user row, one account row and one auth.user.created audit row",
    () =>
      Effect.gen(function* () {
        const federation = yield* FederatedIdentity.make;
        const input = identity(withEmail("new@acme.example"));
        const [a, b] = yield* Effect.all(
          [
            federation.resolve(input, FederatedIdentity.untrusted),
            federation.resolve(input, FederatedIdentity.untrusted),
          ],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(a.userId, b.userId);
        assert.strictEqual(yield* rows("users"), 1);
        assert.strictEqual(yield* rows("accounts"), 1);
        assert.strictEqual(yield* countOf("auth.user.created"), 1);
      }).pipe(Effect.provide(env({ meet: 2 }))),
  );

  it.effect("an auto-link race leaves one account row and one auth.account.linked audit row", () =>
    Effect.gen(function* () {
      const federation = yield* FederatedIdentity.make;
      const users = yield* Users.Users;
      const holder = yield* users.create({
        identity: { _tag: "Email", email: "ada@acme.example" },
        name: "Ada",
      });
      yield* users.verifyEmail(holder.id);
      const [a, b] = yield* Effect.all(
        [
          federation.resolve(identity(), FederatedIdentity.trusted("any")),
          federation.resolve(identity(), FederatedIdentity.trusted("any")),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual([a._tag, b._tag].toSorted(), ["AutoLinked", "Linked"]);
      assert.strictEqual(yield* rows("accounts"), 1);
      assert.strictEqual(yield* countOf("auth.account.linked"), 1);
    }).pipe(Effect.provide(env({ meet: 2 }))),
  );

  it.effect(
    "the losing sign-up's unit leaves nothing behind (no second user, no orphan account)",
    () =>
      Effect.gen(function* () {
        const federation = yield* FederatedIdentity.make;
        const input = identity({ ...withoutEmail, subject: "anon-sql" });
        const [a, b] = yield* Effect.all(
          [
            federation.resolve(input, FederatedIdentity.untrusted),
            federation.resolve(input, FederatedIdentity.untrusted),
          ],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(a.userId, b.userId);
        assert.strictEqual(yield* rows("users"), 1);
        assert.strictEqual(yield* rows("accounts"), 1);
      }).pipe(Effect.provide(env({ meet: 2 }))),
  );

  it.effect(
    "a resolve nested in an outer transaction (the RLS tenant shape) that loses its create recovers: the savepoint rolls back and the outer transaction stays usable",
    () =>
      Effect.gen(function* () {
        const federation = yield* FederatedIdentity.make;
        const sql = yield* SqlClient.SqlClient;
        const input = identity({ ...withoutEmail, subject: "nested" });
        const winner = yield* federation.resolve(input, FederatedIdentity.untrusted);
        // The first anchor read is stale (`None`): the create is attempted, collides on the anchor, and the
        // re-read finds the winner. All of that happens inside the caller's transaction.
        const loser = yield* sql.withTransaction(
          Effect.gen(function* () {
            const resolved = yield* federation.resolve(input, FederatedIdentity.untrusted);
            // The outer transaction is not poisoned: it can still read and write.
            const users = yield* Users.Users;
            const extra = yield* users.create({
              identity: { _tag: "Email", email: "after@acme.example" },
              name: "After",
            });
            return { resolved, extra };
          }),
        );
        assert.strictEqual(loser.resolved._tag, "Linked");
        assert.strictEqual(loser.resolved.userId, winner.userId);
        assert.strictEqual(yield* rows("users"), 2);
        assert.strictEqual(yield* rows("accounts"), 1);
        assert.isTrue(Option.isSome(yield* (yield* Users.Users).findByEmail("after@acme.example")));
      }).pipe(Effect.provide(env({ staleFirstRead: true }))),
  );
});
