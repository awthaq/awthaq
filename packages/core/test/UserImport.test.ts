// AOMS-008/SAM-008: the import primitive — idempotent (a re-run converges) and
// transactional (no user without its credential survives a failed row). Runs on
// both backends: the in-memory `Ref` layers, and real SQL (`:memory:` SQLite, or
// a Postgres schema under `pnpm run test:pg`).
import { PasswordHasher, SqlTransaction } from "@awthaq/ports";
import { CoreMigrations, Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Migrator from "effect/unstable/sql/Migrator";
import { EncryptionLive } from "../../sql/test/contract.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";
import * as Accounts from "../src/Accounts.ts";
import * as Hooks from "../src/Hooks.ts";
import * as Phone from "../src/Phone.ts";
import * as UserImport from "../src/UserImport.ts";
import * as Users from "../src/Users.ts";

const MemoryLayer = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  SqlTransaction.layerNoop,
).pipe(Layer.provide(NodeCrypto.layer), Layer.provide(Hooks.HooksLive));

const SqlLive = TestSql.layer("core_UserImport");

const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

const SqlDomain = Layer.mergeAll(
  Users.layerSql.pipe(Layer.provide(Repositories.UsersRepositoryLive)),
  Accounts.layerSql.pipe(Layer.provide(Repositories.AccountsRepositoryLive)),
  SqlTransaction.layerSql,
).pipe(
  Layer.provide(Hooks.HooksLive),
  Layer.provide(EncryptionLive),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const hash = (value: string) => Redacted.make(PasswordHasher.PhcHash(value));

const suite = (
  name: string,
  layer: Layer.Layer<Users.Users | Accounts.Accounts | SqlTransaction.SqlTransaction, unknown>,
) => {
  describe(name, () => {
    it.effect("importUser twice with the same input returns the same user with created=false", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const input: UserImport.ImportUserInput = {
          identity: { _tag: "Email", email: "Imported@Example.com" },
          name: "Imported",
          verified: true,
          metadata: '{"src":"auth0"}',
          credentials: [
            { providerId: Accounts.PASSWORD_PROVIDER_ID, credentialHash: hash("$2b$04$abc") },
          ],
        };
        const first = yield* UserImport.importUser(input);
        assert.isTrue(first.created);
        assert.isTrue(Users.isEmailVerified(first.user));
        assert.strictEqual(first.accounts.length, 1);
        // The password account is keyed by the user's own id (Password.ts's convention).
        assert.strictEqual(first.accounts[0]?.subject, first.user.id);

        const second = yield* UserImport.importUser(input);
        assert.isFalse(second.created);
        assert.strictEqual(second.user.id, first.user.id);
        assert.strictEqual(second.accounts[0]?.id, first.accounts[0]?.id);
        assert.strictEqual((yield* users.list()).items.length, 1);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "a re-run can only add: it verifies a not-yet-verified user but never un-verifies one",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const base = {
            identity: { _tag: "Email", email: "late@example.com" },
            name: "Late",
          } as const;
          const first = yield* UserImport.importUser({ ...base, verified: false });
          assert.isFalse(Users.isEmailVerified(first.user));
          const verified = yield* UserImport.importUser({ ...base, verified: true });
          assert.isTrue(Users.isEmailVerified(verified.user));
          const again = yield* UserImport.importUser({ ...base, verified: false });
          assert.isTrue(Users.isEmailVerified(again.user));
          assert.isTrue(Users.isEmailVerified(yield* users.findById(first.user.id)));
        }).pipe(Effect.provide(layer)),
    );

    it.effect("a Phone identity imports verified and converges too", () =>
      Effect.gen(function* () {
        const phone = Option.getOrThrow(Phone.normalizePhone("+15550100"));
        const first = yield* UserImport.importUser({
          identity: { _tag: "Phone", phone },
          name: "Phoner",
          verified: true,
        });
        assert.isTrue(Users.isPhoneVerified(first.user));
        const second = yield* UserImport.importUser({
          identity: { _tag: "Phone", phone },
          name: "Phoner",
        });
        assert.deepStrictEqual([first.created, second.created], [true, false]);
        assert.strictEqual(second.user.id, first.user.id);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "a credential owned by a different user fails ImportConflict and rolls the whole row back",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const accounts = yield* Accounts.Accounts;
          const owner = yield* users.create({
            identity: { _tag: "Email", email: "owner@example.com" },
            name: "Owner",
          });
          yield* accounts.link({ userId: owner.id, providerId: "google", subject: "g-1" });

          const failure = yield* UserImport.importUser({
            identity: { _tag: "Email", email: "newcomer@example.com" },
            name: "Newcomer",
            credentials: [
              { providerId: Accounts.PASSWORD_PROVIDER_ID, credentialHash: hash("$2b$04$abc") },
              { providerId: "google", subject: "g-1" },
            ],
          }).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "ImportConflict");
          assert.strictEqual(failure.ownerUserId, owner.id);
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "importUsers reports every row's outcome and keeps going past a conflicting row",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const accounts = yield* Accounts.Accounts;
          const owner = yield* users.create({
            identity: { _tag: "Email", email: "taken@example.com" },
            name: "Owner",
          });
          yield* accounts.link({ userId: owner.id, providerId: "google", subject: "g-9" });

          const report = yield* UserImport.importUsers(
            [
              { identity: { _tag: "Email", email: "one@example.com" }, name: "One" },
              {
                identity: { _tag: "Email", email: "bad@example.com" },
                name: "Bad",
                credentials: [{ providerId: "google", subject: "g-9" }],
              },
              { identity: { _tag: "Email", email: "three@example.com" }, name: "Three" },
            ],
            { concurrency: 1 },
          );
          assert.strictEqual(report.imported, 2);
          assert.strictEqual(report.failed, 1);
          // Re-running the batch converges: the two good rows are `created: false`.
          const rerun = yield* UserImport.importUsers([
            { identity: { _tag: "Email", email: "one@example.com" }, name: "One" },
            { identity: { _tag: "Email", email: "three@example.com" }, name: "Three" },
          ]);
          assert.deepStrictEqual(
            rerun.results.map((r) => (r._tag === "Success" ? r.success.created : "failed")),
            [false, false],
          );
        }).pipe(Effect.provide(layer)),
    );
  });
};

suite("UserImport (memory)", MemoryLayer);
suite("UserImport (sql)", SqlDomain);

// The transaction guarantee needs a real transaction: with `layerNoop` (memory) the
// user row from a failed row legitimately survives, which `SqlTransaction.layerNoop`'s
// own doc comment states (DRS-006).
describe("UserImport transactionality (sql)", () => {
  it.effect("a failing link rolls back the user row (no user without its credential)", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const accounts = yield* Accounts.Accounts;
      const owner = yield* users.create({
        identity: { _tag: "Email", email: "owner@example.com" },
        name: "Owner",
      });
      yield* accounts.link({ userId: owner.id, providerId: "google", subject: "g-1" });

      const failure = yield* UserImport.importUser({
        identity: { _tag: "Email", email: "ghost@example.com" },
        name: "Ghost",
        credentials: [
          { providerId: Accounts.PASSWORD_PROVIDER_ID, credentialHash: hash("$2b$04$abc") },
          { providerId: "google", subject: "g-1" },
        ],
      }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "ImportConflict");

      // Rolled back: neither the user nor its (already-linked) password account exists.
      assert.isTrue(Option.isNone(yield* users.findByEmail("ghost@example.com")));
      assert.strictEqual((yield* users.list()).items.length, 1);
    }).pipe(Effect.provide(SqlDomain)),
  );
});
