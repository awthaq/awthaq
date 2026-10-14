// ADR-EA-038, BEH-EA-323: `SignUp`'s rollback is only real on a SQL transaction. The same
// guarantees `SignUp.test.ts` proves over memory (a conflict, a failing `within`, a vetoed or
// failed first session all leave nothing behind) run here over SQLite, and over Postgres under
// `pnpm test:pg` (`packages/test/src/TestSql.ts`).
import * as TestEncryption from "../../test/src/TestEncryption.ts";
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
import * as Persistence from "../src/Persistence.ts";
import * as Accounts from "../src/Accounts.ts";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Errors from "../src/Errors.ts";
import * as HookPoint from "../src/HookPoint.ts";
import * as Hooks from "../src/Hooks.ts";
import * as Sessions from "../src/Sessions.ts";
import * as SignUp from "../src/SignUp.ts";
import * as Users from "../src/Users.ts";
import * as TestSql from "../../test/src/TestSql.ts";

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

const SqlLive = TestSql.layer("core_SignUpSql");
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

interface Behaviour {
  readonly signInAbort?: boolean;
  readonly sessionsOutage?: boolean;
}

const SessionsOutage = Layer.effect(
  Sessions.Sessions,
  Effect.map(Sessions.Sessions, (inner) =>
    Sessions.Sessions.of({
      ...inner,
      issue: () => Effect.fail(new Errors.StoreUnavailable({ operation: "Sessions.issue" })),
    }),
  ),
);

const envFor = (behaviour: Behaviour = {}) => {
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
  const taps = Hooks.BeforeSignIn.tap((input) =>
    behaviour.signInAbort === true
      ? Effect.fail(new HookPoint.HookAbort({ code: "SIGNIN_DENIED" }))
      : Effect.succeed(input),
  ).pipe(Layer.provideMerge(Hooks.HooksLive));
  const withOutage =
    behaviour.sessionsOutage === true ? SessionsOutage.pipe(Layer.provideMerge(base)) : base;
  return Layer.provideMerge(taps, withOutage);
};

const application = (email: string): SignUp.Application => ({
  identity: { _tag: "Email", email },
  name: "Ada",
  strategy: "password",
});

const rowsOf = (email: string) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const found = yield* users.findByEmail(email);
    return Option.isSome(found);
  });

describe("SignUp over a real transaction", () => {
  it.effect("create persists the user, the verified flag and the linked credential together", () =>
    Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      const accounts = yield* Accounts.Accounts;
      const user = yield* signUp.create(yield* signUp.vet(application("ok@example.com")), {
        verified: true,
        link: { providerId: "acme", subject: "acme-ok" },
      });
      assert.isTrue(Users.isEmailVerified(user));
      assert.isTrue(Option.isSome(yield* accounts.findByProviderSubject("acme", "acme-ok")));
      const rows = yield* (yield* AuditLog.AuditLog).list({ eventTag: "auth.user.created" });
      assert.strictEqual(rows.length, 1);
    }).pipe(Effect.provide(envFor())),
  );

  it.effect("a duplicate email is IdentityTaken and a link conflict leaves no user behind", () =>
    Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      const link = { providerId: "acme", subject: "acme-1" };
      yield* signUp.create(yield* signUp.vet(application("first@example.com")), { link });
      const duplicate = yield* Effect.flip(
        signUp.create(yield* signUp.vet(application("first@example.com"))),
      );
      assert.strictEqual(duplicate._tag, "SignUp/IdentityTaken");
      const conflict = yield* Effect.flip(
        signUp.create(yield* signUp.vet(application("second@example.com")), { link }),
      );
      assert.deepStrictEqual(
        [conflict._tag, "kind" in conflict ? conflict.kind : ""],
        ["SignUp/IdentityTaken", "Account"],
      );
      assert.isFalse(yield* rowsOf("second@example.com"));
      const rows = yield* (yield* AuditLog.AuditLog).list({ eventTag: "auth.user.created" });
      assert.strictEqual(rows.length, 1);
    }).pipe(Effect.provide(envFor())),
  );

  it.effect("a failing within rolls back the user and the account, and announces nothing", () =>
    Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      const accounts = yield* Accounts.Accounts;
      const failure = yield* Effect.flip(
        signUp.createWith(
          yield* signUp.vet(application("bad@example.com")),
          { link: { providerId: "scim", subject: "bad" } },
          () => Effect.fail("membership refused" as const),
        ),
      );
      assert.strictEqual(failure, "membership refused");
      assert.isFalse(yield* rowsOf("bad@example.com"));
      assert.isTrue(Option.isNone(yield* accounts.findByProviderSubject("scim", "bad")));
      const rows = yield* (yield* AuditLog.AuditLog).list({});
      assert.deepStrictEqual(
        rows.map((row) => row.eventTag),
        [],
      );
    }).pipe(Effect.provide(envFor())),
  );

  it.effect(
    "createSignedIn: user and session commit together; a veto or an outage leaves neither",
    () =>
      Effect.gen(function* () {
        const signUp = yield* SignUp.make;
        const sessions = yield* Sessions.Sessions;
        const issued = yield* signUp.createSignedIn(
          yield* signUp.vet(application("in@example.com")),
          {
            amr: ["pwd"],
          },
        );
        assert.strictEqual((yield* sessions.list(issued.session.userId)).length, 1);
        assert.isTrue(yield* rowsOf("in@example.com"));
      }).pipe(Effect.provide(envFor())),
  );

  it.effect("createSignedIn: a BeforeSignIn veto rolls the account back", () =>
    Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      const error = yield* Effect.flip(
        signUp.createSignedIn(yield* signUp.vet(application("vetoed@example.com")), {
          amr: ["pwd"],
        }),
      );
      assert.strictEqual(error._tag, "HookAborted");
      assert.isFalse(yield* rowsOf("vetoed@example.com"));
    }).pipe(Effect.provide(envFor({ signInAbort: true }))),
  );

  it.effect(
    "createSignedIn: a session-store outage rolls the account back as StoreUnavailable",
    () =>
      Effect.gen(function* () {
        const signUp = yield* SignUp.make;
        const error = yield* Effect.flip(
          signUp.createSignedIn(yield* signUp.vet(application("down@example.com")), {
            amr: ["pwd"],
          }),
        );
        assert.strictEqual(error._tag, "StoreUnavailable");
        assert.isFalse(yield* rowsOf("down@example.com"));
        const sql = yield* SqlClient.SqlClient;
        const sessionRows = yield* sql`SELECT COUNT(*) AS n FROM sessions`;
        assert.strictEqual(Number(sessionRows[0]?.["n"]), 0);
      }).pipe(Effect.provide(envFor({ sessionsOutage: true }))),
  );
});
