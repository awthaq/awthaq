// CSG-001/DRS-002/SEA-001/ESA-005 (wayfinder ticket 30): `AccountErasure.eraseAccount`,
// the one guaranteed-complete erasure cascade, and the `ErasureRegistry` plugins contribute to.
//
// The same behaviours run over memory; the atomicity claims (a failing contribution, or a
// late veto, undoes *everything*) need a real transaction, so they run over SQLite, migrated
// by `@awthaq/sql`'s own `CoreMigrations` — the schema is FK-less on purpose (SEA-001), so
// this rollback is the only thing standing between a crash and a half-erased account.
import { Encryption, KeyProvider, SqlTransaction } from "@awthaq/ports";
import { CoreMigrations, Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as Accounts from "../src/Accounts.ts";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Erasure from "../src/Erasure.ts";
import * as HookPoint from "../src/HookPoint.ts";
import * as Hooks from "../src/Hooks.ts";
import * as Sessions from "../src/Sessions.ts";
import * as Users from "../src/Users.ts";
import * as Verification from "../src/Verification.ts";

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

/** What a test wants to observe and steer, shared by both stacks. */
interface Probe {
  /** The order contributions actually ran in. */
  readonly ran: Array<string>;
  /** A late veto: the point is consulted a second time inside `Users.delete` (BEH-EA-095). */
  vetoAfter: number;
  consults: number;
}

const makeProbe = (): Probe => ({ ran: [], vetoAfter: Number.POSITIVE_INFINITY, consults: 0 });

/** Registers `id`'s contribution, which records that it ran and then runs `body`. */
const contribution = (
  probe: Probe,
  id: string,
  order: number,
  body: (subject: Erasure.ErasureSubject) => Effect.Effect<void> = () => Effect.void,
) =>
  Erasure.contribute({
    id,
    order,
    make: Effect.succeed((subject: Erasure.ErasureSubject) =>
      Effect.sync(() => probe.ran.push(id)).pipe(Effect.andThen(body(subject))),
    ),
  });

/** The veto point: a legal hold on `hold@example.com`, or a veto after `probe.vetoAfter` consults. */
const vetoTap = (probe: Probe) =>
  Hooks.BeforeUserDelete.tap((input) =>
    Effect.suspend(() => {
      probe.consults += 1;
      return input.email === "hold@example.com" || probe.consults > probe.vetoAfter
        ? Effect.fail(new HookPoint.HookAbort({ code: "LEGAL_HOLD" }))
        : Effect.succeed(input);
    }),
  );

/** The hook points + erasure registry, with the probe's tap installed. */
const hooksFor = (probe: Probe) => vetoTap(probe).pipe(Layer.provideMerge(Hooks.HooksLive));

const memoryLayer = (
  probe: Probe,
  contributions: Layer.Layer<never, never, Erasure.ErasureRegistry | Accounts.Accounts>,
  config: Partial<Erasure.ErasureConfigShape> = {},
) =>
  Layer.mergeAll(Erasure.layer.pipe(Layer.provide(Erasure.config(config))), contributions).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Users.layerMemory,
        Accounts.layerMemory,
        Sessions.layerMemory,
        Verification.layerMemory,
        SqlTransaction.layerNoop,
      ),
    ),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(hooksFor(probe)),
    Layer.provideMerge(NodeCrypto.layer),
  );

const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

const sqlLayer = (
  probe: Probe,
  contributions: Layer.Layer<never, never, Erasure.ErasureRegistry | Accounts.Accounts>,
) =>
  Layer.mergeAll(Erasure.layer, contributions).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Users.layerSql.pipe(Layer.provide(Repositories.UsersRepositoryLive)),
        Accounts.layerSql.pipe(
          Layer.provide(Repositories.AccountsRepositoryLive.pipe(Layer.provide(EncryptionLive))),
        ),
        Sessions.layerSql.pipe(Layer.provide(Repositories.SessionsRepositoryLive)),
        Verification.layerSql.pipe(
          Layer.provide(
            Layer.mergeAll(
              Repositories.VerificationRepositoryLive,
              Repositories.VerificationReservationsRepositoryLive,
            ),
          ),
        ),
        SqlTransaction.layerSql,
      ),
    ),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerSql.pipe(Layer.provide(Repositories.AuditLogRepositoryLive))),
    Layer.provideMerge(hooksFor(probe)),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(Migrated),
  );

/** A user with an account, a live session, a verification token and one audit row naming them. */
const seedUser = (email: string) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const accounts = yield* Accounts.Accounts;
    const sessions = yield* Sessions.Sessions;
    const verification = yield* Verification.Verification;
    const user = yield* users.create({ identity: { _tag: "Email", email }, name: "Seeded" });
    yield* accounts.link({ userId: user.id, providerId: "google", subject: `sub-${email}` });
    const { session } = yield* sessions.issue({ userId: user.id });
    yield* verification.issue({
      identifier: `email:${email}`,
      ttl: Duration.hours(1),
      userId: user.id,
    });
    return { user, sessionId: session.id };
  });

const remaining = (userId: Users.UserId) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const accounts = yield* Accounts.Accounts;
    const sessions = yield* Sessions.Sessions;
    return {
      user: Option.isSome(yield* users.findById(userId).pipe(Effect.option)),
      accounts: (yield* accounts.listByUser(userId)).length,
      sessions: (yield* sessions.list(userId)).length,
    };
  });

const suite = (
  name: string,
  build: (
    probe: Probe,
    contributions: Layer.Layer<never, never, Erasure.ErasureRegistry | Accounts.Accounts>,
  ) => Layer.Layer<
    | Erasure.AccountErasure
    | Users.Users
    | Accounts.Accounts
    | Sessions.Sessions
    | Verification.Verification
    | AuditLog.AuditLog
    | Erasure.ErasureRegistry,
    unknown
  >,
) =>
  describe(name, () => {
    it.effect("erases the core rows, runs every contribution in order, then announces once", () => {
      const probe = makeProbe();
      const layer = build(
        probe,
        Layer.mergeAll(
          contribution(probe, "b", 2),
          contribution(probe, "a", 1),
          contribution(probe, "c", 1),
        ),
      );
      return Effect.gen(function* () {
        const erasure = yield* Erasure.AccountErasure;
        const auditLog = yield* AuditLog.AuditLog;
        const { user } = yield* seedUser("erase@example.com");
        const other = yield* seedUser("keep@example.com");
        yield* Effect.sleep(0);

        yield* erasure.eraseAccount(user.id, { deletedBy: "admin" });

        // order, then id
        assert.deepStrictEqual(probe.ran, ["a", "c", "b"]);
        assert.deepStrictEqual(yield* remaining(user.id), {
          user: false,
          accounts: 0,
          sessions: 0,
        });
        assert.deepStrictEqual(yield* remaining(other.user.id), {
          user: true,
          accounts: 1,
          sessions: 1,
        });

        // ESA-005: what is left of the audit trail no longer names the user, except the
        // erasure receipt itself, which carries the (now orphan) opaque id and no email.
        const naming = yield* auditLog.list({ actorUserId: user.id });
        assert.deepStrictEqual(
          naming.map((row) => row.payload._tag),
          ["auth.user.deleted"],
        );
        const deleted = naming[0]?.payload;
        assert.strictEqual(deleted?._tag === "auth.user.deleted" && deleted.deletedBy, "admin");
        assert.isFalse(JSON.stringify(naming).includes("erase@example.com"));
        // the other user's trail is untouched
        assert.isAbove((yield* auditLog.list({ actorUserId: other.user.id })).length, 0);
      }).pipe(Effect.provide(layer));
    });

    it.effect("an unknown user fails UserNotFound and touches nothing", () => {
      const probe = makeProbe();
      const layer = build(probe, contribution(probe, "a", 1));
      return Effect.gen(function* () {
        const erasure = yield* Erasure.AccountErasure;
        const failure = yield* erasure
          .eraseAccount(Users.UserId("00000000-0000-4000-8000-000000000000"))
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "UserNotFound");
        assert.deepStrictEqual(probe.ran, []);
      }).pipe(Effect.provide(layer));
    });

    it.effect(
      "a BeforeUserDelete veto runs first: no contribution, no row touched, no event",
      () => {
        const probe = makeProbe();
        const layer = build(probe, contribution(probe, "a", 1));
        return Effect.gen(function* () {
          const erasure = yield* Erasure.AccountErasure;
          const auditLog = yield* AuditLog.AuditLog;
          const { user } = yield* seedUser("hold@example.com");

          const failure = yield* erasure.eraseAccount(user.id).pipe(Effect.flip);

          assert.strictEqual(failure._tag, "HookAborted");
          assert.deepStrictEqual(probe.ran, []);
          assert.deepStrictEqual(yield* remaining(user.id), {
            user: true,
            accounts: 1,
            sessions: 1,
          });
          assert.deepStrictEqual(yield* auditLog.list({ eventTag: "auth.user.deleted" }), []);
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "a registry read freezes it: a contribution registered afterwards is a defect",
      () => {
        const probe = makeProbe();
        const layer = build(probe, contribution(probe, "a", 1));
        return Effect.gen(function* () {
          const registry = yield* Erasure.ErasureRegistry;
          const first = yield* registry.contributions;
          assert.deepStrictEqual(
            first.map((c) => c.id),
            ["a"],
          );
          const exit = yield* Effect.exit(
            registry.register({ id: "late", erase: () => Effect.void }),
          );
          assert.isTrue(Exit.isFailure(exit));
          assert.deepStrictEqual(
            (yield* registry.contributions).map((c) => c.id),
            ["a"],
          );
        }).pipe(Effect.provide(layer));
      },
    );
  });

suite("AccountErasure over memory", (probe, contributions) => memoryLayer(probe, contributions));

describe("AccountErasure over memory: ErasureConfig", () => {
  it.effect('auditLog: "retain" keeps the audit rows that name the user', () => {
    const probe = makeProbe();
    const layer = memoryLayer(probe, Layer.empty, { auditLog: "retain" });
    return Effect.gen(function* () {
      const erasure = yield* Erasure.AccountErasure;
      const auditLog = yield* AuditLog.AuditLog;
      const { user } = yield* seedUser("retain@example.com");
      const before = (yield* auditLog.list({ actorUserId: user.id })).length;
      assert.isAbove(before, 0);
      yield* erasure.eraseAccount(user.id);
      // the same rows are still there, plus the erasure receipt
      assert.isAtLeast((yield* auditLog.list({ actorUserId: user.id })).length, before);
      assert.isTrue(
        (yield* auditLog.list({ actorUserId: user.id })).some(
          (row) => row.payload._tag === "auth.session.issued",
        ),
      );
    }).pipe(Effect.provide(layer));
  });
});

suite("AccountErasure over SQLite", (probe, contributions) => sqlLayer(probe, contributions));

describe("AccountErasure over SQLite: atomicity", () => {
  it.effect(
    "a contribution that dies rolls back the earlier contributions and every core row",
    () => {
      const probe = makeProbe();
      const layer = sqlLayer(
        probe,
        Layer.mergeAll(
          // Deletes the user's accounts, through the real repository, inside the transaction...
          Erasure.contribute({
            id: "sweeps-accounts",
            order: 1,
            make: Effect.gen(function* () {
              const accounts = yield* Accounts.Accounts;
              return (subject: Erasure.ErasureSubject) => accounts.deleteAllByUser(subject.userId);
            }),
          }),
          // ...and the next one dies.
          contribution(probe, "boom", 2, () => Effect.die(new Error("plugin store unavailable"))),
        ),
      );
      return Effect.gen(function* () {
        const erasure = yield* Erasure.AccountErasure;
        const auditLog = yield* AuditLog.AuditLog;
        const { user } = yield* seedUser("rollback@example.com");
        const auditBefore = JSON.stringify(yield* auditLog.list({ actorUserId: user.id }));

        const exit = yield* Effect.exit(erasure.eraseAccount(user.id));

        assert.isTrue(Exit.isFailure(exit));
        assert.deepStrictEqual(probe.ran, ["boom"]);
        // the account sweep was undone with everything else
        assert.deepStrictEqual(yield* remaining(user.id), { user: true, accounts: 1, sessions: 1 });
        // no announcement, and the audit rows still name the user
        assert.deepStrictEqual(yield* auditLog.list({ eventTag: "auth.user.deleted" }), []);
        assert.strictEqual(
          JSON.stringify(yield* auditLog.list({ actorUserId: user.id })),
          auditBefore,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "a veto raised late, inside Users.delete, undoes the accounts, sessions and tokens already removed",
    () => {
      const probe = makeProbe();
      // The first consult is `eraseAccount`'s own veto-first check; the second is `Users.delete`'s,
      // by which point every other core row has been deleted in the transaction.
      probe.vetoAfter = 1;
      const layer = sqlLayer(probe, contribution(probe, "a", 1));
      return Effect.gen(function* () {
        const erasure = yield* Erasure.AccountErasure;
        const { user } = yield* seedUser("late@example.com");

        const failure = yield* erasure.eraseAccount(user.id).pipe(Effect.flip);

        assert.strictEqual(failure._tag, "HookAborted");
        assert.strictEqual(probe.consults, 2);
        assert.deepStrictEqual(yield* remaining(user.id), { user: true, accounts: 1, sessions: 1 });
      }).pipe(Effect.provide(layer));
    },
  );
});
