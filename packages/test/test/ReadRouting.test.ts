// RRC-001 / RRC-008 (wayfinder ticket 28): opt-in read-replica routing and the
// causal handoffs it must never break (ADR-EA-014: revocation and rotation are
// authoritative on the very next read). The replica is a real second database
// that only changes when the test calls `catchUp` (`LaggingReplica`).
import { AuditLog, AuthEvents, Sessions, Users } from "@awthaq/core";
import { CoreMigrations, Models, ReadRouting, Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Model from "effect/unstable/schema/Model";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as LaggingReplica from "../src/LaggingReplica.ts";

const M = Models.makeModels("sqlite");

/** A fresh in-memory SQLite database with the core schema applied. */
const MigratedSqlite = Layer.unwrap(
  Effect.sync(() => {
    const client = SqliteClient.layer({ filename: ":memory:" });
    return Layer.provideMerge(
      Layer.effectDiscard(Migrator.make({})({ loader: CoreMigrations.coreMigrations })).pipe(
        Layer.provide(client),
      ),
      client,
    );
  }),
);

/** A migrated second database, wrapped as a lagging replica of the ambient primary. */
const newReplica = Effect.gen(function* () {
  // `fresh`: layers are memoized per build, and this must not be the primary's own client.
  const context = yield* Layer.build(Layer.fresh(MigratedSqlite));
  return yield* LaggingReplica.make({ replica: Context.get(context, SqlClient.SqlClient) });
});

const userId = Users.UserId("11111111-1111-1111-1111-111111111111");

const insertSession = (sessions: Repositories.SessionsRepositoryShape) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const later = DateTime.add(now, { hours: 1 });
    return yield* sessions.insert(
      M.Session.insert.make({
        userId,
        secretHash: "h",
        ipAddress: null,
        userAgent: null,
        absoluteExpiresAt: later,
        idleExpiresAt: Model.Override(later),
        actingAsType: null,
        actingAsId: null,
        familyId: Schema.decodeUnknownSync(Models.SessionId)("fam"),
        supersededBy: null,
        supersededAt: null,
        reusedAt: null,
      }),
    );
  });

const listCount = (
  sessions: Repositories.SessionsRepositoryShape,
  consistency?: ReadRouting.Consistency,
) =>
  sessions
    .listByUser(
      userId,
      undefined,
      undefined,
      consistency === undefined ? undefined : { consistency },
    )
    .pipe(Effect.map((page) => page.items.length));

describe("ReadRouting (RRC-001)", () => {
  it.effect("with no replica provided, every read goes to the primary", () =>
    Effect.gen(function* () {
      const router = yield* ReadRouting.makeRouter;
      assert.strictEqual(yield* router.target("eventual"), "primary");
      const sessions = yield* Repositories.SessionsRepository;
      yield* insertSession(sessions);
      // An eventual read with no replica configured is simply the primary.
      assert.strictEqual(yield* listCount(sessions, "eventual"), 1);
      assert.strictEqual(yield* listCount(sessions), 1);
    }).pipe(
      Effect.provide(Repositories.SessionsRepositoryLive.pipe(Layer.provideMerge(MigratedSqlite))),
    ),
  );

  it.effect(
    "with a replica, only an eventual listing reads it; everything else reads the primary",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lag = yield* newReplica;
          const context = yield* Layer.build(
            Repositories.SessionsRepositoryLive.pipe(Layer.provide(lag.layer)),
          );
          const sessions = Context.get(context, Repositories.SessionsRepository);
          const session = yield* insertSession(sessions);

          // The replica has not caught up: it does not have the row yet.
          assert.strictEqual(yield* listCount(sessions, "eventual"), 0);
          // The default is authoritative, and point reads are primary-pinned.
          assert.strictEqual(yield* listCount(sessions), 1);
          assert.strictEqual(yield* listCount(sessions, "authoritative"), 1);
          assert.strictEqual((yield* sessions.findById(session.id)).id, session.id);

          yield* lag.catchUp;
          assert.strictEqual(yield* listCount(sessions, "eventual"), 1);
        }).pipe(Effect.provide(MigratedSqlite)),
      ),
  );

  it.effect("AuditLog.list is an eventual read by default and can be forced to the primary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lag = yield* newReplica;
        const context = yield* Layer.build(
          Repositories.AuditLogRepositoryLive.pipe(Layer.provide(lag.layer)),
        );
        const audit = Context.get(context, Repositories.AuditLogRepository);
        const now = yield* DateTime.now;
        yield* audit.insert({
          id: "a1",
          eventTag: "auth.test",
          actorUserId: null,
          occurredAt: now,
          correlationId: null,
          payload: {},
        });
        const all = {
          eventTag: null,
          actorUserId: null,
          occurredAfter: null,
          occurredBefore: null,
        };
        assert.strictEqual((yield* audit.list(all)).length, 0);
        assert.strictEqual((yield* audit.list(all, { consistency: "authoritative" })).length, 1);
        yield* lag.catchUp;
        assert.strictEqual((yield* audit.list(all)).length, 1);
      }).pipe(Effect.provide(MigratedSqlite)),
    ),
  );

  it.effect(
    "a causal token ahead of the replica's position forces the primary until it catches up",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lag = yield* newReplica;
          const context = yield* Layer.build(
            Repositories.SessionsRepositoryLive.pipe(Layer.provide(lag.layer)),
          );
          const sessions = Context.get(context, Repositories.SessionsRepository);
          const session = yield* insertSession(sessions);
          yield* lag.catchUp; // the replica now has the session

          // A write on the primary, wrapped by its caller in `captureToken`.
          const revokedInFiber = ReadRouting.captureToken(sessions.delete(session.id)).pipe(
            Effect.andThen(
              Effect.all({
                eventual: listCount(sessions, "eventual"),
                authoritative: listCount(sessions),
              }),
            ),
            // The token is set on the fiber's own context; scope it to this case.
            Effect.provideService(ReadRouting.CurrentCausalToken, Option.none()),
            // `captureToken` reads the ambient replica config, so provide it at the
            // top of the request the way an application would.
            Effect.provide(lag.layer),
          );
          const during = yield* revokedInFiber;
          // The replica still has the row, but this fiber wrote after it: primary.
          assert.deepStrictEqual(during, { eventual: 0, authoritative: 0 });

          // A fiber with no token still sees the (stale) replica; catch-up ends the staleness.
          assert.strictEqual(yield* listCount(sessions, "eventual"), 1);
          yield* lag.catchUp;
          assert.strictEqual(yield* listCount(sessions, "eventual"), 0);
        }).pipe(Effect.provide(MigratedSqlite)),
      ),
  );

  it.effect("withCausalToken seeds a token from elsewhere (cross-request continuity)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lag = yield* newReplica;
        const context = yield* Layer.build(
          Repositories.SessionsRepositoryLive.pipe(Layer.provide(lag.layer)),
        );
        const sessions = Context.get(context, Repositories.SessionsRepository);
        yield* insertSession(sessions);
        const ahead = Schema.decodeUnknownSync(ReadRouting.CausalToken)("5");
        // Replica position 0 < 5: primary, so the row is visible.
        const seeded = yield* listCount(sessions, "eventual").pipe(
          ReadRouting.withCausalToken(ahead),
        );
        assert.strictEqual(seeded, 1);
        assert.strictEqual(yield* listCount(sessions, "eventual"), 0);
      }).pipe(Effect.provide(MigratedSqlite)),
    ),
  );

  it.effect(
    "failing to read the primary's position pins the fiber to the primary, never fails the write",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lag = yield* newReplica;
          const context = yield* Layer.build(
            Repositories.SessionsRepositoryLive.pipe(Layer.provide(lag.layer)),
          );
          const sessions = Context.get(context, Repositories.SessionsRepository);
          // The write reaches the primary only; the replica stays empty.
          yield* insertSession(sessions);
          assert.strictEqual(yield* listCount(sessions, "eventual"), 0);

          const afterFailedCapture = yield* ReadRouting.captureToken(Effect.void).pipe(
            Effect.andThen(listCount(sessions, "eventual")),
            Effect.provideService(ReadRouting.CurrentCausalToken, Option.none()),
            // The position source is read when the write finishes; here it is down.
            Effect.provideService(ReadRouting.ReplicationPosition, {
              current: () => Effect.fail("position unavailable"),
              hasReplayed: () => Effect.succeed(true),
            }),
            Effect.provide(lag.layer),
          );
          // The write still succeeded, and the fiber is held to the primary (which has the row).
          assert.strictEqual(afterFailedCapture, 1);
        }).pipe(Effect.provide(MigratedSqlite)),
      ),
  );
});

// ---- RRC-008: the causal handoffs, through the real Sessions service -----------------

/** Sessions over a primary plus a lagging replica of it. */
const sessionsUnderLag = Effect.gen(function* () {
  const lag = yield* newReplica;
  const context = yield* Layer.build(
    Sessions.layerSql.pipe(
      Layer.provide(Repositories.SessionsRepositoryLive),
      Layer.provide(lag.layer),
      Layer.provide(Layer.mergeAll(NodeCrypto.layer, AuthEvents.layer)),
      Layer.provide(AuditLog.layerMemory),
    ),
  );
  return { lag, sessions: Context.get(context, Sessions.Sessions) };
});

describe("causal handoffs under replica lag (RRC-008)", () => {
  it.effect("verify right after issue succeeds while the replica has never seen the session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sessions } = yield* sessionsUnderLag;
        const { token } = yield* sessions.issue({ userId });
        const verified = yield* sessions.verify(token);
        assert.strictEqual(verified.session.userId, userId);
      }).pipe(Effect.provide(MigratedSqlite)),
    ),
  );

  it.effect("verify after revoke fails even though the lagging replica still has the row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { lag, sessions } = yield* sessionsUnderLag;
        const { session, token } = yield* sessions.issue({ userId });
        yield* lag.catchUp; // the replica now holds the live session…
        yield* sessions.revoke(session.id); // …and is then left behind by the revoke
        const failure = yield* sessions.verify(token).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "SessionNotFound");
      }).pipe(Effect.provide(MigratedSqlite)),
    ),
  );

  it.effect("a rotated session's new token verifies on the very next read under lag", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { lag, sessions } = yield* sessionsUnderLag;
        const first = yield* sessions.issue({ userId });
        yield* lag.catchUp;
        const rotated = yield* sessions.issue({ userId, supersedes: first.session.id });
        const verified = yield* sessions.verify(rotated.token);
        assert.strictEqual(verified.session.id, rotated.session.id);
        // The superseded token is a tombstone on the primary, whatever the replica says.
        const old = yield* sessions.verify(first.token).pipe(Effect.flip);
        assert.strictEqual(old._tag, "SessionNotFound");
      }).pipe(Effect.provide(MigratedSqlite)),
    ),
  );
});
