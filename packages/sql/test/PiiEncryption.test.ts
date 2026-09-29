// CSG-006 (option B): opt-in application-level encryption of the non-lookup
// personal-data columns — `sessions.ipAddress`/`userAgent` and
// `users.metadata` — through `Encryption`, by choosing the `…EncryptedLive`
// repository layers. The default layers store them as given.
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
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as Models from "../src/Models.ts";
import * as Repositories from "../src/Repositories.ts";
import { EncryptionLive } from "./contract.ts";

const M = Models.makeModels("sqlite");

const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const Base = Layer.provideMerge(
  Layer.effectDiscard(Migrator.make({})({ loader: CoreMigrations.coreMigrations })).pipe(
    Layer.provide(SqlLive),
  ),
  SqlLive,
);

const userId = Schema.decodeUnknownSync(Models.UserId)("pii-user");

const newSession = (ipAddress: string | null, userAgent: string | null) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const later = DateTime.add(now, { hours: 1 });
    return M.Session.insert.make({
      userId,
      secretHash: "h",
      ipAddress,
      userAgent,
      absoluteExpiresAt: later,
      idleExpiresAt: Model.Override(later),
      actingAsType: null,
      actingAsId: null,
      familyId: Schema.decodeUnknownSync(Models.SessionId)("fam"),
      supersededBy: null,
      supersededAt: null,
      reusedAt: null,
    });
  });

const rawSession = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly ipAddress: string | null;
      readonly userAgent: string | null;
    }>`SELECT "ipAddress", "userAgent" FROM sessions WHERE id = ${id}`;
    const row = rows[0];
    assert.isDefined(row);
    return row;
  });

const rawMetadata = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly metadata: string | null }>`
      SELECT metadata FROM users WHERE id = ${id}`;
    return rows[0]?.metadata;
  });

/** The default and the encrypted repositories over the same database, in one scope. */
const both = Effect.gen(function* () {
  const plain = yield* Layer.build(
    Layer.mergeAll(Repositories.SessionsRepositoryLive, Repositories.UsersRepositoryLive),
  );
  const sealed = yield* Layer.build(
    Layer.mergeAll(
      Repositories.SessionsRepositoryEncryptedLive,
      Repositories.UsersRepositoryEncryptedLive,
    ).pipe(Layer.provide(EncryptionLive)),
  );
  return {
    plainSessions: Context.get(plain, Repositories.SessionsRepository),
    plainUsers: Context.get(plain, Repositories.UsersRepository),
    sessions: Context.get(sealed, Repositories.SessionsRepository),
    users: Context.get(sealed, Repositories.UsersRepository),
  };
});

describe("PII column encryption (CSG-006)", () => {
  it.effect("default repositories store the columns as given", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { plainSessions, plainUsers } = yield* both;
        const session = yield* plainSessions.insert(yield* newSession("203.0.113.9", "Agent/1.0"));
        assert.deepStrictEqual(yield* rawSession(session.id), {
          ipAddress: "203.0.113.9",
          userAgent: "Agent/1.0",
        });
        const user = yield* plainUsers.insert(
          yield* M.User.insert.makeEffect({ email: "a@example.com", name: "A", metadata: "{}" }),
        );
        assert.strictEqual(yield* rawMetadata(user.id), "{}");
      }).pipe(Effect.provide(Base)),
    ),
  );

  it.effect(
    "sessions: ipAddress/userAgent are ciphertext at rest and plaintext through every read",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { sessions } = yield* both;
          const session = yield* sessions.insert(yield* newSession("203.0.113.9", "Agent/1.0"));
          // insert hands back plaintext…
          assert.strictEqual(session.ipAddress, "203.0.113.9");
          // …but the bytes on disk are not the plaintext.
          const raw = yield* rawSession(session.id);
          assert.notStrictEqual(raw.ipAddress, "203.0.113.9");
          assert.notStrictEqual(raw.userAgent, "Agent/1.0");
          assert.notInclude(raw.ipAddress ?? "", "203.0.113");

          assert.strictEqual((yield* sessions.findById(session.id)).userAgent, "Agent/1.0");
          const page = yield* sessions.listByUser(userId, yield* DateTime.now);
          assert.strictEqual(page.items[0]?.ipAddress, "203.0.113.9");

          const now = yield* DateTime.now;
          const touched = yield* sessions.touch({
            id: session.id,
            expectedSecretHash: "h",
            secretHash: "h2",
            lastActiveAt: now,
            idleExpiresAt: now,
          });
          assert.strictEqual(Option.getOrThrow(touched).ipAddress, "203.0.113.9");
          const reauthenticated = yield* sessions.reauthenticate(session.id, now);
          assert.strictEqual(reauthenticated.userAgent, "Agent/1.0");
          // Writes that never touch the columns leave the ciphertext alone.
          assert.deepStrictEqual(yield* rawSession(session.id), raw);
        }).pipe(Effect.provide(Base)),
      ),
  );

  it.effect(
    "sessions: null columns stay null, and a ciphertext moved to another row does not decrypt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { sessions } = yield* both;
          const sql = yield* SqlClient.SqlClient;
          const a = yield* sessions.insert(yield* newSession("203.0.113.9", null));
          const b = yield* sessions.insert(yield* newSession("198.51.100.4", "B"));
          assert.strictEqual(a.userAgent, null);
          assert.strictEqual((yield* rawSession(a.id)).userAgent, null);

          // AAD binds row and column: A's ciphertext pasted into B's column is unreadable.
          const stolen = (yield* rawSession(a.id)).ipAddress;
          yield* sql`UPDATE sessions SET "ipAddress" = ${stolen} WHERE id = ${b.id}`;
          const reread = yield* sessions.findById(b.id);
          assert.strictEqual(reread.ipAddress, null); // degraded and logged, never plaintext
          assert.strictEqual(reread.userAgent, "B");
        }).pipe(Effect.provide(Base)),
      ),
  );

  it.effect("plaintext rows written before opting in stay readable and are sealed on read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { plainSessions, sessions } = yield* both;
        const legacy = yield* plainSessions.insert(yield* newSession("203.0.113.9", "Old/1.0"));
        assert.strictEqual((yield* rawSession(legacy.id)).ipAddress, "203.0.113.9");

        const read = yield* sessions.findById(legacy.id);
        assert.strictEqual(read.ipAddress, "203.0.113.9");
        assert.strictEqual(read.userAgent, "Old/1.0");
        // Lazily sealed (AccountsRepositoryConfig.reencryptOnRead, on by default).
        const sealed = yield* rawSession(legacy.id);
        assert.notStrictEqual(sealed.ipAddress, "203.0.113.9");
        assert.strictEqual((yield* sessions.findById(legacy.id)).ipAddress, "203.0.113.9");
      }).pipe(Effect.provide(Base)),
    ),
  );

  it.effect(
    "users.metadata: ciphertext at rest, plaintext through insert/update/reads; email stays plaintext",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { users } = yield* both;
          const created = yield* users.insert(
            yield* M.User.insert.makeEffect({
              email: "meta@example.com",
              name: "M",
              metadata: '{"plan":"pro"}',
            }),
          );
          assert.strictEqual(created.metadata, '{"plan":"pro"}');
          const raw = yield* rawMetadata(created.id);
          assert.notInclude(raw ?? "", "pro");

          assert.strictEqual((yield* users.findById(created.id)).metadata, '{"plan":"pro"}');
          const byEmail = yield* users.findByEmail("META@example.com");
          assert.strictEqual(Option.getOrThrow(byEmail).metadata, '{"plan":"pro"}');
          assert.strictEqual((yield* users.verifyEmail(created.id)).metadata, '{"plan":"pro"}');

          const updated = yield* users.update(
            yield* M.User.update.makeEffect({
              id: created.id,
              email: created.email,
              name: "M2",
              metadata: '{"plan":"team"}',
            }),
          );
          assert.strictEqual(updated.metadata, '{"plan":"team"}');
          assert.notInclude((yield* rawMetadata(created.id)) ?? "", "team");

          const none = yield* users.insert(
            yield* M.User.insert.makeEffect({ email: "none@example.com", name: "N" }),
          );
          assert.strictEqual(none.metadata, null);
          assert.strictEqual(yield* rawMetadata(none.id), null);
        }).pipe(Effect.provide(Base)),
      ),
  );
});
