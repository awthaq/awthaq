// P20a/AH-003, decision 36 Tier 4: the harness for 01-contract-and-persistence/05-persistence-stratum.feature.
//
// One fresh in-memory SQLite database per `withDatabase` call, migrated by the real framework
// `Migrator` over `CoreMigrations.coreMigrations`, with every repository over it — the same
// composition `packages/sql/test/contract.ts` uses, so a passing scenario is evidence about the
// real encode/decode/SQL round-trip. A scenario's Given records what to arrange, its When runs the
// whole flow against one database inside a single `withDatabase`, and the Then reads the result
// back from the scratch (`FoundationsWorld`).
import { Persistence, Users } from "@awthaq/core";
import {
  AccountStoreSql,
  Models,
  CoreMigrations,
  SessionStoreSql,
  UserStoreSql,
} from "@awthaq/sql";
import { AccountStore, Encryption, KeyProvider, UserStore } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { TestAuth } from "@awthaq/test";

/** The SQLite-dialect models: what the store adapters decode with on this database. */
export const M = Models.makeModels("sqlite");

/** A fixed test key, isolated from the real `process.env` (the same one `packages/sql`'s own suite uses). */
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

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

/** Every core store adapter over one migrated in-memory database. */
export const StoresLive = Layer.mergeAll(
  UserStoreSql.layer,
  AccountStoreSql.layer.pipe(Layer.provide(EncryptionLive)),
  SessionStoreSql.layer,
).pipe(Layer.provideMerge(SqlLive), Layer.provideMerge(Migrated));

/** Runs `effect` against a brand-new migrated database that is thrown away afterwards. */
export const withDatabase = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof StoresLive>>) =>
  Effect.provide(effect, StoresLive);

/** An in-memory tracer collecting every span the effect it is provided to starts. */
export const collectSpans = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer };
};

/**
 * One user stored through the `UserStore` port, read back as the `User` model entity (the row exactly
 * as the database holds it). The id is the model's supplier-assigned UuidV7 default.
 */
export const insertUser = (email: string, createdAt?: DateTime.Utc) =>
  Effect.gen(function* () {
    const users = yield* UserStore.UserStore;
    const sql = yield* SqlClient.SqlClient;
    const { id } = yield* M.User.insert.makeEffect({ email, name: email });
    const at = createdAt ?? (yield* DateTime.now);
    yield* users.insertOrHolder({
      id,
      email: Option.some(email),
      emailVerified: false,
      phone: Option.none(),
      phoneVerified: false,
      name: email,
      image: Option.none(),
      metadata: Option.none(),
      status: "active",
      statusReason: Option.none(),
      suspendedUntil: Option.none(),
      createdAt: at,
      updatedAt: at,
    });
    return yield* SqlSchema.findOne({
      Request: Models.UserId,
      Result: M.User,
      execute: (userId) => sql`SELECT * FROM users WHERE id = ${userId}`,
    })(id);
  });

/**
 * One account stored through the `AccountStore` port (its tokens sealed at rest), read back as the
 * `Account` model entity: the row exactly as the database holds it, secrets included.
 */
export const insertAccount = (input: {
  readonly userId: Models.UserId;
  readonly providerId: string;
  readonly subject: string;
  readonly passwordHash: string | null;
  readonly accessToken: string | null;
}) =>
  Effect.gen(function* () {
    const accounts = yield* AccountStore.AccountStore;
    const sql = yield* SqlClient.SqlClient;
    const id = Schema.decodeUnknownSync(Models.AccountId)(globalThis.crypto.randomUUID());
    const at = yield* DateTime.now;
    yield* accounts.insertIfAbsent({
      id,
      userId: input.userId,
      providerId: input.providerId,
      subject: input.subject,
      issuer: "",
      credentialHash: Option.map(Option.fromNullOr(input.passwordHash), Redacted.make),
      tokens: Option.map(Option.fromNullOr(input.accessToken), (accessToken) => ({
        accessToken: Redacted.make(accessToken),
        refreshToken: Option.none(),
        idToken: Option.none(),
        accessTokenExpiresAt: Option.none(),
        refreshTokenExpiresAt: Option.none(),
        scope: Option.none(),
        tokenType: Option.none(),
      })),
      createdAt: at,
      updatedAt: at,
    });
    return yield* SqlSchema.findOne({
      Request: Models.AccountId,
      Result: M.Account,
      execute: (accountId) => sql`SELECT * FROM accounts WHERE id = ${accountId}`,
    })(id);
  });

export const optionValue = <A>(option: Option.Option<A>): A | undefined =>
  Option.isSome(option) ? option.value : undefined;

/** The domain `Users` service over memory — the "ordinary creation path" a caller goes through (`create` takes no id). */
export const MemoryUsersLive = Users.layer
  .pipe(Layer.provide(Persistence.memory))
  .pipe(Layer.provideMerge(TestAuth.memoryFoundation));

/**
 * `Persistence.sql({ encryptPii: true })` over a fresh migrated in-memory database, with an `Encryption` whose current key
 * a scenario can rotate and retire (plan 17, BEH-EA-339): the composition a deployment runs, and the keyset it rotates.
 */
export const sealedStack = () => {
  let current = "k1";
  const retired = new Set<string>();
  const material = (kid: string): KeyProvider.KeyMaterial => ({
    kid,
    key: Redacted.make(new Uint8Array(32).fill(kid.charCodeAt(kid.length - 1) % 251)),
  });
  const provider = KeyProvider.KeyProvider.of({
    currentKey: Effect.sync(() => material(current)),
    getKey: (kid) =>
      retired.has(kid)
        ? Effect.fail(new KeyProvider.UnknownKeyId({ kid }))
        : Effect.succeed(material(kid)),
  });
  const client = SqliteClient.layer({ filename: ":memory:" });
  const migrated = Layer.effectDiscard(
    Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
  ).pipe(Layer.provide(client));
  return {
    rotateTo: (kid: string) => {
      current = kid;
    },
    retire: (kid: string) => {
      retired.add(kid);
    },
    layer: Persistence.sql({ encryptPii: true }).pipe(
      Layer.provideMerge(
        Encryption.layer.pipe(
          Layer.provide(Layer.succeed(KeyProvider.KeyProvider, provider)),
          Layer.provide(NodeCrypto.layer),
        ),
      ),
      Layer.provideMerge(migrated),
      Layer.provideMerge(client),
    ),
  };
};
