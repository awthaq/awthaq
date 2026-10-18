// spec/behaviors/05-persistence-stratum.md, BEH-EA-033 through BEH-EA-036.
//
// ESR-009: the dialect-neutral contract cases — every repository behavior
// that must hold identically on every dialect — as one function that each
// database-specific suite (`Repositories.test.ts` on `:memory:` SQLite,
// `Repositories.file.test.ts` on a WAL file, `Repositories.postgres.test.ts`
// on a real server) calls with its own migrated `SqlClient` layer, so a new
// case lands on every dialect at once.
import { Encryption, KeyProvider } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Model from "effect/unstable/schema/Model";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as AccountStoreSql from "../src/AccountStoreSql.ts";
import * as AuditLogStoreSql from "../src/AuditLogStoreSql.ts";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as Models from "../src/Models.ts";
import * as Repositories from "../src/Repositories.ts";
import * as UserStoreSql from "../src/UserStoreSql.ts";
import * as VerificationStoreSql from "../src/VerificationStoreSql.ts";

// Shipping-gap map (.scratch/shipping-gaps), ticket 18:
// `Repositories.AccountsRepositoryLive` requires `Encryption` — a
// fixed test key, isolated from the real `process.env`.
export const EncryptionLive = Encryption.layer.pipe(
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

/**
 * Every repository over `SqlLive`, after the real framework `Migrator` has run
 * `CoreMigrations.coreMigrations` (shipping-gap map, ticket 15) — proves the
 * migration set itself is correct, not just the repositories built on it.
 * `prepare` runs first (e.g. the Postgres suite resets its schema).
 */
export const repositoriesLayer = <E>(
  SqlLive: Layer.Layer<SqlClient.SqlClient, E>,
  prepare: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.void,
) => {
  const Migrated = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* prepare;
      yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
    }),
  ).pipe(Layer.provide(SqlLive));

  return Layer.mergeAll(
    Repositories.SessionsRepositoryLive,
    // Plan 16: the audit log and verification stores are adapters without a repository; suites that need a row use the port.
    AuditLogStoreSql.layer,
    VerificationStoreSql.layer,
    AccountStoreSql.layer.pipe(Layer.provide(EncryptionLive)),
    UserStoreSql.layer,
  ).pipe(Layer.provideMerge(SqlLive), Layer.provideMerge(Migrated));
};

export const contractCases = (
  label: string,
  dialect: Models.Dialect,
  RepositoriesLive: ReturnType<typeof repositoriesLayer>,
  options: { readonly skip: boolean } = { skip: false },
) => {
  const M = Models.makeModels(dialect);

  describe.skipIf(options.skip)(label, () => {
    /** A user for the session cases: `sessions` has no foreign key, so the row need not exist. */
    const makeUser = (email: string) =>
      Effect.map(M.User.insert.makeEffect({ email, name: "S" }), ({ id }) => ({ id, email }));

    it.effect(
      "BEH-EA-050: Sessions repository persists only the secret's hash, never a secret",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Repositories.SessionsRepository;
          const user = yield* makeUser("session@example.com");
          const now = yield* DateTime.now;
          const session = yield* sessions.insert(
            yield* M.Session.insert.makeEffect({
              userId: user.id,
              secretHash: "hashed-secret-value",
              ipAddress: null,
              userAgent: "test-agent",
              absoluteExpiresAt: now,
              idleExpiresAt: Model.Override(now),
              actingAsType: null,
              actingAsId: null,
              familyId: Schema.decodeUnknownSync(Models.SessionId)("fixture-family"),
              supersededBy: null,
              supersededAt: null,
              reusedAt: null,
            }),
          );
          assert.strictEqual(session.secretHash, "hashed-secret-value");
          const json = yield* Schema.encodeUnknownEffect(M.Session.json)(session);
          assert.notProperty(json, "secretHash");
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect("BEH-EA-036: Sessions.listByUser pages by (createdAt, id), never an offset", () =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        const user = yield* makeUser("many-sessions@example.com");
        const now = yield* DateTime.now;
        const future = DateTime.addDuration(now, Duration.days(1));
        for (let i = 0; i < 5; i++) {
          yield* sessions.insert(
            yield* M.Session.insert.makeEffect({
              userId: user.id,
              secretHash: `hash-${i}`,
              ipAddress: null,
              userAgent: null,
              absoluteExpiresAt: future,
              idleExpiresAt: Model.Override(future),
              actingAsType: null,
              actingAsId: null,
              familyId: Schema.decodeUnknownSync(Models.SessionId)("fixture-family"),
              supersededBy: null,
              supersededAt: null,
              reusedAt: null,
            }),
          );
        }

        const firstPage = yield* sessions.listByUser(user.id, now, undefined, 2);
        assert.strictEqual(firstPage.items.length, 2);
        assert.isTrue(Option.isSome(firstPage.nextCursor));

        const cursor = firstPage.nextCursor.pipe(
          Option.getOrThrowWith(() => new Error("expected a cursor")),
        );
        const secondPage = yield* sessions.listByUser(user.id, now, cursor, 2);
        assert.strictEqual(secondPage.items.length, 2);
        assert.isTrue(Option.isSome(secondPage.nextCursor));

        const thirdPage = yield* sessions.listByUser(
          user.id,
          now,
          secondPage.nextCursor.pipe(Option.getOrThrowWith(() => new Error("expected a cursor"))),
          2,
        );
        assert.strictEqual(thirdPage.items.length, 1);
        assert.isTrue(Option.isNone(thirdPage.nextCursor));

        const allIds = [...firstPage.items, ...secondPage.items, ...thirdPage.items].map(
          (s) => s.id,
        );
        assert.strictEqual(new Set(allIds).size, 5);
      }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect("BEH-EA-054: deleteAllForUserExcept revokes every session but the kept one", () =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        const user = yield* makeUser("revoke@example.com");
        const now = yield* DateTime.now;
        const future = DateTime.addDuration(now, Duration.days(1));
        const make = () =>
          sessions.insert(
            M.Session.insert.make({
              userId: user.id,
              secretHash: "h",
              ipAddress: null,
              userAgent: null,
              absoluteExpiresAt: future,
              idleExpiresAt: Model.Override(future),
              actingAsType: null,
              actingAsId: null,
              familyId: Schema.decodeUnknownSync(Models.SessionId)("fixture-family"),
              supersededBy: null,
              supersededAt: null,
              reusedAt: null,
            }),
          );
        const keep = yield* make();
        yield* make();
        yield* make();

        yield* sessions.deleteAllForUserExcept(user.id, keep.id);
        const remaining = yield* sessions.listByUser(user.id, now, undefined, 10);
        assert.strictEqual(remaining.items.length, 1);
        assert.strictEqual(remaining.items[0]?.id, keep.id);
      }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect(
      "upstream-hardening ticket 02: deleteAllByUser revokes every session, no exceptions",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Repositories.SessionsRepository;
          const user = yield* makeUser("revoke-all@example.com");
          const now = yield* DateTime.now;
          const future = DateTime.addDuration(now, Duration.days(1));
          const make = () =>
            sessions.insert(
              M.Session.insert.make({
                userId: user.id,
                secretHash: "h",
                ipAddress: null,
                userAgent: null,
                absoluteExpiresAt: future,
                idleExpiresAt: Model.Override(future),
                actingAsType: null,
                actingAsId: null,
                familyId: Schema.decodeUnknownSync(Models.SessionId)("fixture-family"),
                supersededBy: null,
                supersededAt: null,
                reusedAt: null,
              }),
            );
          yield* make();
          yield* make();

          yield* sessions.deleteAllByUser(user.id);
          const remaining = yield* sessions.listByUser(user.id, now, undefined, 10);
          assert.strictEqual(remaining.items.length, 0);
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect(
      "upstream-hardening ticket 01: touch's compare-and-swap lets only the first of two racing callers rotate",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Repositories.SessionsRepository;
          const user = yield* makeUser("touch-race@example.com");
          const now = yield* DateTime.now;
          const session = yield* sessions.insert(
            M.Session.insert.make({
              userId: user.id,
              secretHash: "original-hash",
              ipAddress: null,
              userAgent: null,
              absoluteExpiresAt: now,
              idleExpiresAt: Model.Override(now),
              actingAsType: null,
              actingAsId: null,
              familyId: Schema.decodeUnknownSync(Models.SessionId)("fixture-family"),
              supersededBy: null,
              supersededAt: null,
              reusedAt: null,
            }),
          );

          // Two callers both read the row before either wrote — both present
          // the same `expectedSecretHash`, the value that was actually live
          // at the time they read it.
          const first = yield* sessions.touch({
            id: session.id,
            expectedSecretHash: "original-hash",
            secretHash: "rotated-by-first",
            previousSecretHash: "original-hash",
            previousSecretExpiresAt: now,
            lastActiveAt: now,
            idleExpiresAt: now,
          });
          assert.isTrue(Option.isSome(first), "the first caller should win the race");
          assert.strictEqual(Option.getOrThrow(first).secretHash, "rotated-by-first");
          // RRS-005: the replaced hash is kept aside, with its expiry, by the same write.
          assert.strictEqual(Option.getOrThrow(first).previousSecretHash, "original-hash");
          assert.isNotNull(Option.getOrThrow(first).previousSecretExpiresAt);

          // The second caller's own compare-and-swap is guarded against the
          // now-stale hash it read before the first caller's write landed —
          // it must not clobber the winner's row with its own rotation.
          const second = yield* sessions.touch({
            id: session.id,
            expectedSecretHash: "original-hash",
            secretHash: "rotated-by-second",
            lastActiveAt: now,
            idleExpiresAt: now,
          });
          assert.isTrue(Option.isNone(second), "the second, losing caller must not overwrite");

          const current = yield* sessions.findById(session.id);
          assert.strictEqual(current.secretHash, "rotated-by-first");
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    // The verification cases (the atomic claim, the live-row replacement, the reservation claim and its
    // boundary, the hash at rest, the payload round trip) are `StoreContract.verification` and
    // `VerificationStoreSql.test.ts` (plan 16).

    // ESR-009: the RETURNING-decoded session writes of RRS-003/ticket 15 —
    // a timestamp/nullable-timestamp round trip through each dialect's codec.
    it.effect(
      "RRS-003: tombstone/markReused/reauthenticate decode their RETURNING rows; revokeFamily deletes only live rows",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Repositories.SessionsRepository;
          const user = yield* makeUser("rotation@example.com");
          const now = yield* DateTime.now;
          // Live for an hour: `reauthenticate` refuses a dead row (BEH-EA-319).
          const expires = DateTime.addDuration(now, Duration.hours(1));
          const make = (hash: string) =>
            sessions.insert(
              M.Session.insert.make({
                userId: user.id,
                secretHash: hash,
                ipAddress: null,
                userAgent: null,
                absoluteExpiresAt: expires,
                idleExpiresAt: Model.Override(expires),
                actingAsType: null,
                actingAsId: null,
                familyId: Schema.decodeUnknownSync(Models.SessionId)("family-1"),
                supersededBy: null,
                supersededAt: null,
                reusedAt: null,
              }),
            );
          const old = yield* make("old");
          const fresh = yield* make("fresh");

          // INV-EA-018: a foreign owner cannot tombstone the row; the owner can.
          const intruder = yield* makeUser("rotation-intruder@example.com");
          const refused = yield* sessions
            .tombstone({
              id: old.id,
              userId: intruder.id,
              supersededBy: fresh.id,
              supersededAt: now,
            })
            .pipe(Effect.flip);
          assert.strictEqual(refused._tag, "NoSuchElementError");
          const tombstoned = yield* sessions.tombstone({
            id: old.id,
            userId: user.id,
            supersededBy: fresh.id,
            supersededAt: now,
          });
          assert.strictEqual(tombstoned.supersededBy, fresh.id);
          assert.isNotNull(tombstoned.supersededAt);
          assert.strictEqual(tombstoned.reusedAt, null);

          // RRS-003: the mark applies once; a second call finds nothing to flag.
          const flagged = yield* sessions.markReusedOnce(old.id, now);
          assert.strictEqual(Option.getOrUndefined(flagged)?.familyId, old.familyId);
          assert.isTrue(Option.isNone(yield* sessions.markReusedOnce(old.id, now)));
          // A live (non-tombstoned) row is never flagged.
          assert.isTrue(Option.isNone(yield* sessions.markReusedOnce(fresh.id, now)));
          const reread = yield* sessions.findById(old.id);
          assert.isNotNull(reread.reusedAt);

          const later = DateTime.addDuration(now, Duration.minutes(5));
          const reauthenticated = yield* sessions.reauthenticate(fresh.id, user.id, later);
          assert.strictEqual(
            DateTime.toEpochMillis(reauthenticated.authenticatedAt),
            DateTime.toEpochMillis(later),
          );
          // BEH-EA-319: the UPDATE's own WHERE refuses a foreign owner, a tombstoned row and an
          // expired instant (the 'old' row is tombstoned; 'fresh' expires an hour out).
          const other = yield* makeUser("rotation-other@example.com");
          const foreign = yield* sessions
            .reauthenticate(fresh.id, other.id, later)
            .pipe(Effect.flip);
          assert.strictEqual(foreign._tag, "NoSuchElementError");
          const dead = yield* sessions.reauthenticate(old.id, user.id, later).pipe(Effect.flip);
          assert.strictEqual(dead._tag, "NoSuchElementError");
          const past = yield* sessions
            .reauthenticate(fresh.id, user.id, DateTime.addDuration(now, Duration.hours(2)))
            .pipe(Effect.flip);
          assert.strictEqual(past._tag, "NoSuchElementError");

          yield* sessions.revokeFamily(Schema.decodeUnknownSync(Models.SessionId)("family-1"));
          // The tombstoned row survives (its lineage is evidence); the live row is gone.
          const survivor = yield* sessions.findById(old.id);
          assert.strictEqual(survivor.id, old.id);
          const gone = yield* sessions.findById(fresh.id).pipe(Effect.flip);
          assert.strictEqual(gone._tag, "NoSuchElementError");
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    // The audit-log repository cases (the `occurredAt` range, the payload round trip, bounded
    // retention deletes) are `StoreContract.auditLog`, which runs on every adapter (plan 02, ADR-EA-041).

    it.effect(
      "CSG-003: deleteExpiredBefore removes expired sessions, bounded by limit, and reports the count",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Repositories.SessionsRepository;
          const user = yield* makeUser("retention@example.com");
          const t0 = DateTime.makeUnsafe("2026-04-01T00:00:00.000Z");
          const at = (days: number) => DateTime.addDuration(t0, Duration.days(days));
          const cutoff = at(10);

          const session = (hash: string, absolute: DateTime.Utc) =>
            sessions.insert(
              M.Session.insert.make({
                userId: user.id,
                secretHash: hash,
                ipAddress: null,
                userAgent: null,
                absoluteExpiresAt: absolute,
                idleExpiresAt: Model.Override(absolute),
                actingAsType: null,
                actingAsId: null,
                familyId: Schema.decodeUnknownSync(Models.SessionId)(`family-${hash}`),
                supersededBy: null,
                supersededAt: null,
                reusedAt: null,
              }),
            );
          const old1 = yield* session("old1", at(1));
          yield* session("old2", at(2));
          const live = yield* session("live", at(30));
          assert.strictEqual(yield* sessions.deleteExpiredBefore(cutoff, 1), 1);
          assert.strictEqual(yield* sessions.deleteExpiredBefore(cutoff, 100), 1);
          assert.strictEqual(yield* sessions.deleteExpiredBefore(cutoff, 100), 0);
          assert.strictEqual((yield* sessions.findById(live.id)).id, live.id);
          assert.strictEqual(
            (yield* sessions.findById(old1.id).pipe(Effect.flip))._tag,
            "NoSuchElementError",
          );
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    // SMS-002/ESR-010/GC-005/ESR-002: the session device-list page query and owned delete.
    const insertLiveSession = (
      userId: Models.UserId,
      options: {
        readonly absoluteExpiresAt: DateTime.Utc;
        readonly idleExpiresAt: DateTime.Utc;
        readonly supersededAt?: DateTime.Utc;
      },
    ) =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        return yield* sessions.insert(
          M.Session.insert.make({
            userId,
            secretHash: "h",
            ipAddress: null,
            userAgent: null,
            absoluteExpiresAt: options.absoluteExpiresAt,
            idleExpiresAt: Model.Override(options.idleExpiresAt),
            actingAsType: null,
            actingAsId: null,
            familyId: Schema.decodeUnknownSync(Models.SessionId)("fixture-family"),
            supersededBy: null,
            supersededAt: options.supersededAt ?? null,
            reusedAt: null,
          }),
        );
      });

    it.effect("SMS-002: listByUser omits absolute-expired, idle-expired and tombstoned rows", () =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        const user = yield* makeUser("live-only@example.com");
        const now = yield* DateTime.now;
        const future = DateTime.addDuration(now, Duration.days(1));
        const past = DateTime.subtractDuration(now, Duration.minutes(1));
        const live = yield* insertLiveSession(user.id, {
          absoluteExpiresAt: future,
          idleExpiresAt: future,
        });
        yield* insertLiveSession(user.id, { absoluteExpiresAt: past, idleExpiresAt: future });
        yield* insertLiveSession(user.id, { absoluteExpiresAt: future, idleExpiresAt: past });
        yield* insertLiveSession(user.id, {
          absoluteExpiresAt: future,
          idleExpiresAt: future,
          supersededAt: past,
        });
        const page = yield* sessions.listByUser(user.id, now);
        assert.deepStrictEqual(
          page.items.map((row) => row.id),
          [live.id],
        );
      }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect("ESR-010: listByUser clamps limit 0 to 1 and still returns a nextCursor", () =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        const user = yield* makeUser("clamp-zero@example.com");
        const now = yield* DateTime.now;
        const future = DateTime.addDuration(now, Duration.days(1));
        yield* insertLiveSession(user.id, { absoluteExpiresAt: future, idleExpiresAt: future });
        yield* insertLiveSession(user.id, { absoluteExpiresAt: future, idleExpiresAt: future });
        const page = yield* sessions.listByUser(user.id, now, undefined, 0);
        assert.strictEqual(page.items.length, 1);
        assert.isTrue(Option.isSome(page.nextCursor));
      }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect("ESR-010: a negative limit does not raise a SqlError", () =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        const user = yield* makeUser("clamp-negative@example.com");
        const now = yield* DateTime.now;
        const future = DateTime.addDuration(now, Duration.days(1));
        yield* insertLiveSession(user.id, { absoluteExpiresAt: future, idleExpiresAt: future });
        const page = yield* sessions.listByUser(user.id, now, undefined, -5);
        assert.strictEqual(page.items.length, 1);
      }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect(
      "ESR-010: listByUser caps the page at MAX_PAGE_SIZE",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Repositories.SessionsRepository;
          const user = yield* makeUser("clamp-huge@example.com");
          const now = yield* DateTime.now;
          const future = DateTime.addDuration(now, Duration.days(1));
          for (let i = 0; i < Repositories.MAX_PAGE_SIZE + 5; i++) {
            yield* insertLiveSession(user.id, {
              absoluteExpiresAt: future,
              idleExpiresAt: future,
            });
          }
          const page = yield* sessions.listByUser(user.id, now, undefined, 100_000);
          assert.strictEqual(page.items.length, Repositories.MAX_PAGE_SIZE);
          assert.isTrue(Option.isSome(page.nextCursor));
        }).pipe(Effect.provide(RepositoriesLive)),
      30_000,
    );

    it.effect(
      "TIR-008/GC-005: deleteReturning deletes once, and only the owner's row when asked",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Repositories.SessionsRepository;
          const owner = yield* makeUser("owner@example.com");
          const other = yield* makeUser("not-owner@example.com");
          const now = yield* DateTime.now;
          const future = DateTime.addDuration(now, Duration.days(1));
          const row = yield* insertLiveSession(owner.id, {
            absoluteExpiresAt: future,
            idleExpiresAt: future,
          });
          assert.isTrue(Option.isNone(yield* sessions.deleteReturning(row.id, other.id)));
          assert.strictEqual((yield* sessions.findById(row.id)).id, row.id);
          assert.strictEqual(
            Option.getOrUndefined(yield* sessions.deleteReturning(row.id, owner.id)),
            owner.id,
          );
          assert.isTrue(Option.isNone(yield* sessions.deleteReturning(row.id, owner.id)));
          const again = yield* insertLiveSession(owner.id, {
            absoluteExpiresAt: future,
            idleExpiresAt: future,
          });
          assert.strictEqual(
            Option.getOrUndefined(yield* sessions.deleteReturning(again.id)),
            owner.id,
          );
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    // DRS-001/DRS-005 (the ambient tenant is stamped on every insert path, and the login lookups stay
    // global) are each port's contract in `StoreContract` (plan 16).

    it.effect("ESR-002: tombstone applies only to a still-live row", () =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        const user = yield* makeUser("tombstone-once@example.com");
        const now = yield* DateTime.now;
        const future = DateTime.addDuration(now, Duration.days(1));
        const row = yield* insertLiveSession(user.id, {
          absoluteExpiresAt: future,
          idleExpiresAt: future,
        });
        const successor = Schema.decodeUnknownSync(Models.SessionId)("successor-1");
        yield* sessions.tombstone({
          id: row.id,
          userId: row.userId,
          supersededBy: successor,
          supersededAt: now,
        });
        const again = yield* sessions
          .tombstone({ id: row.id, userId: row.userId, supersededBy: successor, supersededAt: now })
          .pipe(Effect.flip);
        assert.strictEqual(again._tag, "NoSuchElementError");
      }).pipe(Effect.provide(RepositoriesLive)),
    );
  });
};
