// spec/behaviors/07-sessions.md, BEH-EA-049 through BEH-EA-056.
//
// The same contract suite runs against both `Layer`s — `layerMemory` (a
// `Ref`) and `layerSql` (a real, in-memory SQLite database via
// `@effect/sql-sqlite-node`) — since `TestClock` (auto-provided by
// `it.effect`) is the ambient `Clock` both `DateTime.now` and the SQL
// model's own constructor defaults read from, so `TestClock.adjust`
// controls simulated time identically for either backend.
import { Api } from "@awthaq/api";
import { Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Sessions from "../src/Sessions.ts";
import * as Users from "../src/Users.ts";

const MemoryLayer = Sessions.layerMemory.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provide(AuthEvents.layer),
  Layer.provide(AuditLog.layerMemory),
);

const shortLivedConfig = Layer.succeed(Sessions.SessionConfig, {
  absolute: Duration.millis(1000),
  idle: Duration.millis(500),
  touchEvery: Duration.millis(100),
});

const ShortLivedMemoryLayer = Sessions.layerMemory.pipe(
  Layer.provide(Layer.mergeAll(NodeCrypto.layer, shortLivedConfig, AuthEvents.layer)),
  Layer.provide(AuditLog.layerMemory),
);

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

// RRS-003: `familyId`/`supersededBy`/`supersededAt`/`reusedAt` —
// `@awthaq/sql`'s own `CoreMigrations.ts` migration 10 is the production
// equivalent of this ad hoc test-only schema.
const Migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        secretHash TEXT NOT NULL,
        ipAddress TEXT,
        userAgent TEXT,
        absoluteExpiresAt TEXT NOT NULL,
        idleExpiresAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        authenticatedAt TEXT NOT NULL,
        lastActiveAt TEXT NOT NULL,
        actingAsType TEXT,
        actingAsId TEXT,
        familyId TEXT NOT NULL,
        supersededBy TEXT,
        supersededAt TEXT,
        reusedAt TEXT
      )
    `;
  }),
).pipe(Layer.provide(SqlLive));

const SqlLayer = Sessions.layerSql.pipe(
  Layer.provide(Repositories.SessionsRepositoryLive),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(AuthEvents.layer),
  Layer.provide(AuditLog.layerMemory),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const ShortLivedSqlLayer = Sessions.layerSql.pipe(
  Layer.provide(Repositories.SessionsRepositoryLive),
  Layer.provide(Layer.mergeAll(NodeCrypto.layer, shortLivedConfig, AuthEvents.layer)),
  Layer.provide(AuditLog.layerMemory),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const userId = Users.UserId("11111111-1111-1111-1111-111111111111");

const suite = (
  name: string,
  layer: Layer.Layer<Sessions.Sessions, unknown, never>,
  shortLivedLayer: Layer.Layer<Sessions.Sessions, unknown, never>,
): void => {
  describe(name, () => {
    it.effect(
      "BEH-EA-049/050: issues an opaque id.secret token, never storing the secret itself",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const { session, token } = yield* sessions.issue({ userId });
          const raw = Redacted.value(token);
          assert.include(raw, ".");
          assert.strictEqual(raw.split(".")[0], session.id);

          const { session: view } = yield* sessions.verify(token);
          assert.strictEqual(view.id, session.id);
          assert.strictEqual(view.userId, userId);
        }).pipe(Effect.provide(layer)),
    );

    // RSC-001: a `SessionView` must never carry the stored secret hash (or
    // any other internal row field) at runtime — its own doc comment
    // promises "never the secret, never the stored hash," and a careless
    // prop pass to a Client Component would otherwise serialize it into an
    // RSC flight payload. `deepStrictEqual` against the full expected key
    // set (not just `notProperty("secretHash", ...)`) also catches any
    // other internal-only field (e.g. `familyId`) leaking the same way.
    it.effect("issue/verify never expose secretHash or other internal row fields", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session, token } = yield* sessions.issue({ userId });
        const expectedKeys = [
          "id",
          "userId",
          "createdAt",
          "authenticatedAt",
          "lastActiveAt",
          "absoluteExpiresAt",
          "idleExpiresAt",
          "ipAddress",
          "userAgent",
          "actingAs",
        ].sort();
        assert.deepStrictEqual(Object.keys(session).sort(), expectedKeys);
        assert.notProperty(session, "secretHash");

        const { session: verified } = yield* sessions.verify(token);
        assert.deepStrictEqual(Object.keys(verified).sort(), expectedKeys);
        assert.notProperty(verified, "secretHash");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-050/056: a tampered secret is rejected", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session } = yield* sessions.issue({ userId });
        const bogus = Redacted.make(`${session.id}.not-the-real-secret`);
        const failure = yield* sessions.verify(bogus).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "SessionNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-051/INV-EA-008: idle refresh never pushes past the absolute expiry", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { token } = yield* sessions.issue({ userId });
        // Cross two touchEvery windows, staying under idle (500ms) each
        // time, but past the 1000ms absolute ceiling in total. Ticket 01:
        // each touched verify rotates the secret, so the freshly-rotated
        // token (when present) must be used for the next call — the old
        // one no longer verifies.
        yield* TestClock.adjust(Duration.millis(400));
        const first = yield* sessions.verify(token);
        const afterFirst = Option.getOrElse(first.rotated, () => token);
        yield* TestClock.adjust(Duration.millis(400));
        const second = yield* sessions.verify(afterFirst);
        const afterSecond = Option.getOrElse(second.rotated, () => afterFirst);
        yield* TestClock.adjust(Duration.millis(400));
        const failure = yield* sessions.verify(afterSecond).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "SessionExpired");
      }).pipe(Effect.provide(shortLivedLayer)),
    );

    it.effect(
      "BEH-EA-051: idle expiry fires before the absolute ceiling when idle is exhausted",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const { token } = yield* sessions.issue({ userId });
          yield* TestClock.adjust(Duration.millis(600));
          const failure = yield* sessions.verify(token).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "SessionExpired");
        }).pipe(Effect.provide(shortLivedLayer)),
    );

    // PIL-007: an id-only caller must learn nothing about expiry — the state
    // branches run only after the presented secret is proven.
    it.effect(
      "PIL-007/BEH-EA-056: an expired row with a WRONG secret fails SessionNotFound, not SessionExpired",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const { session } = yield* sessions.issue({ userId });
          yield* TestClock.adjust(Duration.millis(600));
          const forged = Redacted.make(`${session.id}.deadbeef`);
          const failure = yield* sessions.verify(forged).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "SessionNotFound");
        }).pipe(Effect.provide(shortLivedLayer)),
    );

    // TIR-002: `isLive` must apply the exact same idle+absolute logic
    // `verify` does — it exists specifically because `SessionListItem`
    // (and the old `Jwt.ts` live-check built on `Sessions.list`) only ever
    // carried the absolute deadline, silently accepting an idle-expired
    // session as live.
    it.effect("isLive is false once idle-expired, even though absolute expiry is far off", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session } = yield* sessions.issue({ userId });
        yield* TestClock.adjust(Duration.millis(600));
        assert.isFalse(yield* sessions.isLive(userId, session.id));
      }).pipe(Effect.provide(shortLivedLayer)),
    );

    it.effect("isLive is true for a freshly issued, unexpired session", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session } = yield* sessions.issue({ userId });
        assert.isTrue(yield* sessions.isLive(userId, session.id));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("isLive is false for a session belonging to a different userId", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session } = yield* sessions.issue({ userId });
        assert.isFalse(
          yield* sessions.isLive(Users.UserId("22222222-2222-2222-2222-222222222222"), session.id),
        );
      }).pipe(Effect.provide(layer)),
    );

    it.effect("isLive is false for an unknown session id", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        assert.isFalse(yield* sessions.isLive(userId, Sessions.SessionId("does-not-exist")));
      }).pipe(Effect.provide(layer)),
    );

    // Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
    // (AAPS-001): every mint follows a real credential presentation, so
    // `authenticatedAt` starts out identical to `createdAt`.
    it.effect("issue sets authenticatedAt equal to createdAt", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session } = yield* sessions.issue({ userId });
        assert.strictEqual(
          DateTime.toEpochMillis(session.authenticatedAt),
          DateTime.toEpochMillis(session.createdAt),
        );
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "reauthenticate advances authenticatedAt without touching the secret or expiry timestamps",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const { session, token } = yield* sessions.issue({ userId });
          yield* TestClock.adjust(Duration.seconds(30));
          const reauthenticated = yield* sessions.reauthenticate(session.id);
          assert.isAbove(
            DateTime.toEpochMillis(reauthenticated.authenticatedAt),
            DateTime.toEpochMillis(session.authenticatedAt),
          );
          assert.strictEqual(
            DateTime.toEpochMillis(reauthenticated.idleExpiresAt),
            DateTime.toEpochMillis(session.idleExpiresAt),
          );
          assert.strictEqual(
            DateTime.toEpochMillis(reauthenticated.absoluteExpiresAt),
            DateTime.toEpochMillis(session.absoluteExpiresAt),
          );
          // The original secret must still verify — `reauthenticate` must
          // never rotate it (unlike `verify`'s own throttled touch).
          const { session: verified } = yield* sessions.verify(token);
          assert.strictEqual(verified.id, session.id);
        }).pipe(Effect.provide(layer)),
    );

    it.effect("reauthenticate fails with SessionNotFound for an unknown session id", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const failure = yield* sessions
          .reauthenticate(Sessions.SessionId("does-not-exist"))
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "SessionNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-052: idle refresh is throttled to at most one write per touchEvery", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session, token } = yield* sessions.issue({ userId });
        // Well under touchEvery (100ms) — no refresh yet.
        yield* TestClock.adjust(Duration.millis(10));
        const notTouched = yield* sessions.verify(token);
        assert.strictEqual(
          DateTime.toEpochMillis(notTouched.session.lastActiveAt),
          DateTime.toEpochMillis(session.createdAt),
        );
        // Past touchEvery — this verify earns a refresh.
        yield* TestClock.adjust(Duration.millis(200));
        const touched = yield* sessions.verify(token);
        assert.isTrue(
          DateTime.toEpochMillis(touched.session.lastActiveAt) >
            DateTime.toEpochMillis(session.createdAt),
        );
      }).pipe(Effect.provide(shortLivedLayer)),
    );

    it.effect(
      "upstream-hardening ticket 01: the same throttled touch rotates the secret, invalidating the old token immediately",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const { token } = yield* sessions.issue({ userId });
          // Under touchEvery — no rotation yet.
          yield* TestClock.adjust(Duration.millis(10));
          const notTouched = yield* sessions.verify(token);
          assert.deepStrictEqual(notTouched.rotated, Option.none());

          // Past touchEvery — this verify both refreshes and rotates.
          yield* TestClock.adjust(Duration.millis(200));
          const touched = yield* sessions.verify(token);
          assert.isTrue(Option.isSome(touched.rotated));

          // The old token no longer verifies — no grace window.
          const oldFails = yield* sessions.verify(token).pipe(Effect.flip);
          assert.strictEqual(oldFails._tag, "SessionNotFound");

          // The freshly-rotated token verifies and resolves the same session.
          const rotatedToken = Option.getOrThrow(touched.rotated);
          const { session: newView } = yield* sessions.verify(rotatedToken);
          assert.strictEqual(newView.id, touched.session.id);
        }).pipe(Effect.provide(shortLivedLayer)),
    );

    it.effect(
      "BEH-EA-053/RRS-003: issuing with `supersedes` tombstones the prior row — the new one works, the old one stops verifying",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const first = yield* sessions.issue({ userId });
          const second = yield* sessions.issue({ userId, supersedes: first.session.id });
          // Checked before the old token is ever presented: presenting a
          // tombstoned row (below) is itself a reuse signal (RRS-003) that
          // revokes the whole family, `second` included — so this order
          // matters, not just style.
          const newWorks = yield* sessions.verify(second.token);
          assert.strictEqual(newWorks.session.id, second.session.id);
          const oldFails = yield* sessions.verify(first.token).pipe(Effect.flip);
          assert.strictEqual(oldFails._tag, "SessionNotFound");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-054: list/revoke/revokeOthers", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const a = yield* sessions.issue({ userId, request: { userAgent: "device-a" } });
        const b = yield* sessions.issue({ userId, request: { userAgent: "device-b" } });

        const listed = yield* sessions.list(userId, a.session.id);
        assert.strictEqual(listed.length, 2);
        const current = listed.find((row) => row.current);
        assert.strictEqual(current?.id, a.session.id);

        yield* sessions.revokeOthers(userId, a.session.id);
        const bFails = yield* sessions.verify(b.token).pipe(Effect.flip);
        assert.strictEqual(bFails._tag, "SessionNotFound");
        const aStillWorks = yield* sessions.verify(a.token);
        assert.strictEqual(aStillWorks.session.id, a.session.id);

        yield* sessions.revoke(a.session.id);
        const aFails = yield* sessions.verify(a.token).pipe(Effect.flip);
        assert.strictEqual(aFails._tag, "SessionNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "upstream-hardening ticket 02: revokeAll kills every session, including the caller's own",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const a = yield* sessions.issue({ userId, request: { userAgent: "device-a" } });
          const b = yield* sessions.issue({ userId, request: { userAgent: "device-b" } });

          yield* sessions.revokeAll(userId);

          const aFails = yield* sessions.verify(a.token).pipe(Effect.flip);
          assert.strictEqual(aFails._tag, "SessionNotFound");
          const bFails = yield* sessions.verify(b.token).pipe(Effect.flip);
          assert.strictEqual(bFails._tag, "SessionNotFound");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-209: actingAs round-trips through issue/verify", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session, token } = yield* sessions.issue({
          userId,
          actingAs: { type: "user", id: "admin-1" },
        });
        assert.deepStrictEqual(session.actingAs, Option.some({ type: "user", id: "admin-1" }));
        const verified = yield* sessions.verify(token);
        assert.deepStrictEqual(
          verified.session.actingAs,
          Option.some({ type: "user", id: "admin-1" }),
        );
        // Ticket 01: an actingAs session never touches the touch/rotation
        // path at all — its hard expiry is the whole security model.
        assert.deepStrictEqual(verified.rotated, Option.none());
      }).pipe(Effect.provide(layer)),
    );

    it.effect("an ordinary session issued with no actingAs carries none", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session } = yield* sessions.issue({ userId });
        assert.deepStrictEqual(session.actingAs, Option.none());
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "BEH-EA-210: a session issued with actingAs gets idleExpiresAt = absoluteExpiresAt",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const { session } = yield* sessions.issue({
            userId,
            actingAs: { type: "user", id: "admin-1" },
          });
          assert.strictEqual(
            DateTime.toEpochMillis(session.idleExpiresAt),
            DateTime.toEpochMillis(session.absoluteExpiresAt),
          );
        }).pipe(Effect.provide(shortLivedLayer)),
    );

    it.effect("BEH-EA-210: verify never advances idleExpiresAt for an actingAs session", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session, token } = yield* sessions.issue({
          userId,
          actingAs: { type: "user", id: "admin-1" },
        });
        // Cross several touchEvery windows (100ms) — an ordinary session
        // would have its idleExpiresAt pushed forward each time.
        yield* TestClock.adjust(Duration.millis(200));
        const verified = yield* sessions.verify(token);
        assert.strictEqual(
          DateTime.toEpochMillis(verified.session.idleExpiresAt),
          DateTime.toEpochMillis(session.idleExpiresAt),
        );
        assert.strictEqual(
          DateTime.toEpochMillis(verified.session.lastActiveAt),
          DateTime.toEpochMillis(session.lastActiveAt),
        );
      }).pipe(Effect.provide(shortLivedLayer)),
    );

    it.effect(
      "BEH-EA-212: absoluteDuration overrides SessionConfig.absolute for this one call",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const now = yield* DateTime.now;
          const { session } = yield* sessions.issue({
            userId,
            absoluteDuration: Duration.millis(50),
          });
          assert.strictEqual(
            DateTime.toEpochMillis(session.absoluteExpiresAt),
            DateTime.toEpochMillis(now) + 50,
          );
        }).pipe(Effect.provide(layer)),
    );

    // IDS-008: the self-act-as invariant lives in the primitive, not only in
    // the Admin plugin — a producer that skips its own guard dies loudly.
    it.effect("BEH-EA-209: issue refuses actingAs naming the session's own userId", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const exit = yield* sessions
          .issue({ userId, actingAs: { type: "user", id: userId } })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        if (!Exit.isFailure(exit)) return;
        assert.isTrue(Cause.hasDies(exit.cause));
        assert.instanceOf(Cause.squash(exit.cause), Sessions.InvalidActingAs);
        // A different actor is still fine.
        yield* sessions.issue({ userId, actingAs: { type: "user", id: "admin-1" } });
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "an ordinary session's own idle-refresh is unaffected by the actingAs skip logic",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const { session, token } = yield* sessions.issue({ userId });
          yield* TestClock.adjust(Duration.millis(200));
          const verified = yield* sessions.verify(token);
          assert.isTrue(
            DateTime.toEpochMillis(verified.session.lastActiveAt) >
              DateTime.toEpochMillis(session.lastActiveAt),
          );
        }).pipe(Effect.provide(shortLivedLayer)),
    );
  });
};

suite("Sessions (layerMemory)", MemoryLayer, ShortLivedMemoryLayer);
suite("Sessions (layerSql)", SqlLayer, ShortLivedSqlLayer);

// RRS-003 — .scratch/resolve-ready-for-human-findings/issues/
// 11-token-lifecycle-store.md: the `supersedes` rotation path tombstones
// rather than deletes, so a presented-again old token is a detectable
// reuse signal — a compromised token family gets revoked wholesale, not
// silently accepted (the previous hard-delete behavior). These need
// `AuthEvents` exposed to the test body itself (to assert the published
// event), unlike `suite`'s own `layer`/`shortLivedLayer` params.
const MemoryLayerWithEvents = Sessions.layerMemory.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
);

const SqlLayerWithEvents = Sessions.layerSql.pipe(
  Layer.provide(Repositories.SessionsRepositoryLive),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const reuseSuite = (
  name: string,
  layer: Layer.Layer<Sessions.Sessions | AuthEvents.AuthEvents, unknown, never>,
): void => {
  describe(name, () => {
    it.effect(
      "a tombstoned row's second presentation revokes every live session in its family and publishes auth.session.reuse exactly once",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const events = yield* AuthEvents.AuthEvents;

          const reused = yield* Effect.forkChild(
            events.stream.pipe(
              Stream.filter((event) => event._tag === "auth.session.reuse"),
              Stream.take(1),
              Stream.runCollect,
            ),
            { startImmediately: true },
          );

          // A family of three: A -> B -> C, each rotation superseding the
          // one before it.
          const a = yield* sessions.issue({ userId });
          const b = yield* sessions.issue({ userId, supersedes: a.session.id });
          const c = yield* sessions.issue({ userId, supersedes: b.session.id });

          // A's own token, presented again — A is already tombstoned
          // (superseded by B), so this is the reuse signal.
          const firstReplay = yield* sessions.verify(a.token).pipe(Effect.flip);
          assert.strictEqual(firstReplay._tag, "SessionNotFound");

          // C — the only still-live member of the family — is revoked as
          // a side effect of that one reuse.
          const cFails = yield* sessions.verify(c.token).pipe(Effect.flip);
          assert.strictEqual(cFails._tag, "SessionNotFound");

          // A second presentation of the same already-flagged row is
          // still met with the uniform `SessionNotFound` — no
          // distinguishable signal leaked — but does not publish a
          // second event.
          const secondReplay = yield* sessions.verify(a.token).pipe(Effect.flip);
          assert.strictEqual(secondReplay._tag, "SessionNotFound");

          const collected = yield* Fiber.join(reused);
          assert.strictEqual(collected.length, 1);
          const [event] = collected;
          assert.strictEqual(event?._tag, "auth.session.reuse");
          if (event?._tag === "auth.session.reuse") {
            assert.strictEqual(event.sessionId, a.session.id);
            assert.strictEqual(event.familyId, a.session.id);
            assert.strictEqual(event.userId, userId);
          }
        }).pipe(Effect.provide(layer)),
    );

    // PIL-007: the session id is the public half of the token (cookies, JWT
    // `sid`, error messages). Reuse detection must only fire for a caller who
    // also holds the secret — otherwise anyone who knows a superseded id can
    // force-log-out the user's live session.
    it.effect(
      "PIL-007/RRS-003: presenting a superseded id with a WRONG secret revokes nothing and publishes no reuse event",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const events = yield* AuthEvents.AuthEvents;

          const seen = yield* Ref.make(0);
          yield* Effect.forkChild(
            events.stream.pipe(
              Stream.filter((event) => event._tag === "auth.session.reuse"),
              Stream.runForEach(() => Ref.update(seen, (n) => n + 1)),
            ),
            { startImmediately: true },
          );

          const a = yield* sessions.issue({ userId });
          const b = yield* sessions.issue({ userId, supersedes: a.session.id });

          const forged = Redacted.make(`${a.session.id}.deadbeef`);
          const failure = yield* sessions.verify(forged).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "SessionNotFound");

          // The successor is untouched.
          const successor = yield* sessions.verify(b.token);
          assert.strictEqual(successor.session.id, b.session.id);

          for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
          assert.strictEqual(yield* Ref.get(seen), 0);
        }).pipe(Effect.provide(layer)),
    );

    it.effect("PIL-007: replaying the full pre-supersede token still triggers reuse detection", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const a = yield* sessions.issue({ userId });
        const b = yield* sessions.issue({ userId, supersedes: a.session.id });

        const replay = yield* sessions.verify(a.token).pipe(Effect.flip);
        assert.strictEqual(replay._tag, "SessionNotFound");
        const successor = yield* sessions.verify(b.token).pipe(Effect.flip);
        assert.strictEqual(successor._tag, "SessionNotFound");
      }).pipe(Effect.provide(layer)),
    );

    // ESR-002: the supersede is one atomic step, and only a still-live row can
    // be tombstoned — two concurrent supersedes of one row never fork its
    // family (exactly one successor inherits it; the other founds its own).
    it.effect("ESR-002: two concurrent issue(supersedes: same id) never fork the family", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const a = yield* sessions.issue({ userId });
        const [x, y] = yield* Effect.all(
          [
            sessions.issue({ userId, supersedes: a.session.id }),
            sessions.issue({ userId, supersedes: a.session.id }),
          ],
          { concurrency: "unbounded" },
        );
        // Replaying A's token is reuse: it revokes A's family only.
        yield* sessions.verify(a.token).pipe(Effect.flip);
        const outcomes = yield* Effect.all([
          Effect.exit(sessions.verify(x.token)),
          Effect.exit(sessions.verify(y.token)),
        ]);
        assert.strictEqual(outcomes.filter(Exit.isSuccess).length, 1);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("Sessions.list excludes a tombstoned (superseded) row", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const a = yield* sessions.issue({ userId });
        yield* sessions.issue({ userId, supersedes: a.session.id });

        const listed = yield* sessions.list(userId);
        assert.strictEqual(listed.length, 1);
        assert.isUndefined(listed.find((row) => row.id === a.session.id));
      }).pipe(Effect.provide(layer)),
    );
  });
};

reuseSuite("Sessions reuse detection (layerMemory)", MemoryLayerWithEvents);
reuseSuite("Sessions reuse detection (layerSql)", SqlLayerWithEvents);

describe("Sessions", () => {
  it("BEH-EA-055: the session cookie name and attributes are fixed", () => {
    assert.strictEqual(Sessions.SESSION_COOKIE_NAME, "__Host-session");
    // CSS-007: one source — core derives from the contract stratum's constant.
    assert.strictEqual(Sessions.SESSION_COOKIE_NAME, Api.SessionCookie.key);
    assert.strictEqual(Sessions.SESSION_COOKIE_NAME, Api.SESSION_COOKIE_NAME);
    assert.deepStrictEqual(Sessions.SESSION_COOKIE_ATTRIBUTES, {
      secure: true,
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
  });

  // Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
  // (AAPS-001/BPAS-001): the shared comparison `@awthaq/qadi`'s
  // `reauthHandler` and `@awthaq/passkey`'s enrollment gate both apply.
  describe("isStale", () => {
    it("is false exactly at the maxAgeSeconds boundary, true just past it", () => {
      const authenticatedAt = DateTime.makeUnsafe(0);
      const atBoundary = DateTime.makeUnsafe(300_000);
      const pastBoundary = DateTime.makeUnsafe(300_001);
      assert.isFalse(Sessions.isStale(authenticatedAt, 300, atBoundary));
      assert.isTrue(Sessions.isStale(authenticatedAt, 300, pastBoundary));
    });

    it("is false for a session authenticated after `now` (a defensive, not expected, input)", () => {
      const authenticatedAt = DateTime.makeUnsafe(10_000);
      const now = DateTime.makeUnsafe(0);
      assert.isFalse(Sessions.isStale(authenticatedAt, 300, now));
    });
  });
});

// ESR-002/RRS-004: a failing successor insert must roll the tombstone back.
const failNextInsert = Effect.runSync(Ref.make(false));

const FlakyInsertRepository = Layer.effect(
  Repositories.SessionsRepository,
  Effect.gen(function* () {
    const real = yield* Repositories.SessionsRepository;
    return {
      ...real,
      insert: (input: Parameters<typeof real.insert>[0]) =>
        Ref.get(failNextInsert).pipe(
          Effect.flatMap((fail) =>
            fail
              ? Effect.fail(
                  new SqlError({
                    reason: new UnknownError({ cause: new Error("simulated insert failure") }),
                  }),
                )
              : real.insert(input),
          ),
        ),
    };
  }),
).pipe(Layer.provide(Repositories.SessionsRepositoryLive));

const FlakySqlLayer = Sessions.layerSql.pipe(
  Layer.provide(FlakyInsertRepository),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

describe("Sessions atomic supersede (layerSql)", () => {
  it.effect(
    "BEH-EA-053: a failing insert during issue(supersedes) leaves the superseded session live and untombstoned",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const events = yield* AuthEvents.AuthEvents;
        const reuse = yield* Ref.make(0);
        yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter((event) => event._tag === "auth.session.reuse"),
            Stream.runForEach(() => Ref.update(reuse, (n) => n + 1)),
          ),
          { startImmediately: true },
        );

        const a = yield* sessions.issue({ userId });
        yield* Ref.set(failNextInsert, true);
        const exit = yield* sessions.issue({ userId, supersedes: a.session.id }).pipe(Effect.exit);
        yield* Ref.set(failNextInsert, false);
        assert.isTrue(Exit.isFailure(exit));

        // The old token still verifies: the tombstone rolled back with the insert.
        const verified = yield* sessions.verify(a.token);
        assert.strictEqual(verified.session.id, a.session.id);
        for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(reuse), 0);
      }).pipe(Effect.provide(FlakySqlLayer)),
  );
});
