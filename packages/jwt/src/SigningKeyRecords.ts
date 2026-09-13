// @effect-auth/jwt — SigningKeyRecords
//
// .scratch/jwt/spec.md's "Key management" decision. This plugin's own
// persistence for the `jwt_signing_key` table — built directly against
// `effect/unstable/sql`'s `SqlSchema`, the same way
// `@effect-auth/admin`'s own `ImpersonationRecords.ts` builds
// `admin_impersonation`: this table belongs to the plugin, not the shared
// persistence stratum.
//
// `privateKeyJwk` is `Option.Option<Redacted.Redacted<...>>` — `None` under
// a remote-signing configuration (ticket 15's `KeyRing.registerRemoteKey`),
// `Some` under local signing (ticket 07's `mint`). JWK objects are stored as
// JSON text, the same manual `JSON.stringify`/`JSON.parse` convention
// `@effect-auth/organization`'s own `OrgRoleRecords.ts`/`MembershipRecords.ts`
// already use for JSON-shaped columns — no `Schema.parseJson` machinery
// needed for a shape this codebase already has a working, simpler pattern
// for.
//
// `findCurrent`/`listVerifiable` were all ticket 07 needed. `markRotated`
// (ticket 11) sets `rotatedAt`/`retiresAt` on a row — after this, that row
// no longer satisfies `findCurrent`'s "no `rotatedAt` yet" predicate, so
// the next `create` becomes the new current key automatically; it keeps
// satisfying `listVerifiable` until `retiresAt` elapses, via the same
// `isVerifiable` filter already in place.

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import type { Algorithm } from "./JwtConfig.ts";

export type Jwk = Record<string, unknown>;

export interface SigningKeyRecord {
  readonly kid: string;
  readonly alg: Algorithm;
  readonly publicKeyJwk: Jwk;
  readonly privateKeyJwk: Option.Option<Redacted.Redacted<Jwk>>;
  readonly createdAt: DateTime.Utc;
  readonly rotatedAt: Option.Option<DateTime.Utc>;
  readonly retiresAt: Option.Option<DateTime.Utc>;
}

export interface SigningKeyRecordsShape {
  readonly create: (input: {
    readonly kid: string;
    readonly alg: Algorithm;
    readonly publicKeyJwk: Jwk;
    readonly privateKeyJwk: Option.Option<Redacted.Redacted<Jwk>>;
  }) => Effect.Effect<SigningKeyRecord>;
  /** The row with no `rotatedAt` yet — the one currently used to sign new tokens, if any exists. */
  readonly findCurrent: () => Effect.Effect<Option.Option<SigningKeyRecord>>;
  /** Every row not yet past its `retiresAt` (rows with no `retiresAt` at all included). */
  readonly listVerifiable: (now: DateTime.Utc) => Effect.Effect<ReadonlyArray<SigningKeyRecord>>;
  /** Stops `kid` from being `findCurrent`'s row and starts its grace period — it keeps satisfying `listVerifiable` until `retiresAt`. */
  readonly markRotated: (
    kid: string,
    rotatedAt: DateTime.Utc,
    retiresAt: DateTime.Utc,
  ) => Effect.Effect<void>;
}

export class SigningKeyRecords extends Context.Service<SigningKeyRecords, SigningKeyRecordsShape>()(
  "effect-auth/jwt/SigningKeyRecords",
) {}

const newestFirst = (records: ReadonlyArray<SigningKeyRecord>): ReadonlyArray<SigningKeyRecord> =>
  [...records].sort(
    (a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt),
  );

const isVerifiable = (record: SigningKeyRecord, now: DateTime.Utc): boolean =>
  Option.match(record.retiresAt, {
    onNone: () => true,
    onSome: (retiresAt) => DateTime.toEpochMillis(retiresAt) > DateTime.toEpochMillis(now),
  });

// ---- layerMemory ------------------------------------------------------------

type RecordsState = HashMap.HashMap<string, SigningKeyRecord>;

export const layerMemory = Layer.effect(
  SigningKeyRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make<RecordsState>(HashMap.empty());

    const create: SigningKeyRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const now = yield* DateTime.now;
      const record: SigningKeyRecord = {
        kid: input.kid,
        alg: input.alg,
        publicKeyJwk: input.publicKeyJwk,
        privateKeyJwk: input.privateKeyJwk,
        createdAt: now,
        rotatedAt: Option.none(),
        retiresAt: Option.none(),
      };
      yield* Ref.update(state, (s) => HashMap.set(s, record.kid, record));
      return record;
    });

    const findCurrent: SigningKeyRecordsShape["findCurrent"] = () =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          newestFirst(Array.from(HashMap.values(s))).find((row) => Option.isNone(row.rotatedAt)),
        ),
        Effect.map(Option.fromNullishOr),
      );

    const listVerifiable: SigningKeyRecordsShape["listVerifiable"] = (now) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          newestFirst(Array.from(HashMap.values(s))).filter((row) => isVerifiable(row, now)),
        ),
      );

    const markRotated: SigningKeyRecordsShape["markRotated"] = (kid, rotatedAt, retiresAt) =>
      Ref.update(state, (s) =>
        HashMap.modify(s, kid, (row) => ({
          ...row,
          rotatedAt: Option.some(rotatedAt),
          retiresAt: Option.some(retiresAt),
        })),
      );

    return { create, findCurrent, listVerifiable, markRotated };
  }),
);

// ---- layerSql -----------------------------------------------------------------

const SigningKeyRow = Schema.Struct({
  kid: Schema.String,
  alg: Schema.Literals(["EdDSA", "ES256"]),
  publicKeyJwk: Schema.String,
  privateKeyJwk: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  rotatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  retiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const toRecord = (row: typeof SigningKeyRow.Type): SigningKeyRecord => ({
  kid: row.kid,
  alg: row.alg,
  publicKeyJwk: JSON.parse(row.publicKeyJwk),
  privateKeyJwk: Option.fromNullishOr(row.privateKeyJwk).pipe(
    Option.map((json) => Redacted.make(JSON.parse(json))),
  ),
  createdAt: row.createdAt,
  rotatedAt: Option.fromNullishOr(row.rotatedAt),
  retiresAt: Option.fromNullishOr(row.retiresAt),
});

export const layerSql = Layer.effect(
  SigningKeyRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const insert = SqlSchema.findOne({
      Request: Schema.Struct({
        kid: Schema.String,
        alg: Schema.Literals(["EdDSA", "ES256"]),
        publicKeyJwk: Schema.String,
        privateKeyJwk: Schema.NullOr(Schema.String),
        createdAt: Schema.DateTimeUtcFromString,
      }),
      Result: SigningKeyRow,
      execute: (r) => sql`
          INSERT INTO jwt_signing_key
            (kid, alg, publicKeyJwk, privateKeyJwk, createdAt, rotatedAt, retiresAt)
          VALUES
            (${r.kid}, ${r.alg}, ${r.publicKeyJwk}, ${r.privateKeyJwk}, ${r.createdAt}, NULL, NULL)
          RETURNING *
        `,
    });

    const findCurrentQuery = SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: SigningKeyRow,
      execute: () => sql`
          SELECT * FROM jwt_signing_key WHERE rotatedAt IS NULL ORDER BY createdAt DESC LIMIT 1
        `,
    });

    const listVerifiableQuery = SqlSchema.findAll({
      Request: Schema.DateTimeUtcFromString,
      Result: SigningKeyRow,
      execute: (now) => sql`
          SELECT * FROM jwt_signing_key
          WHERE retiresAt IS NULL OR retiresAt > ${now}
          ORDER BY createdAt DESC
        `,
    });

    const markRotatedQuery = SqlSchema.findOne({
      Request: Schema.Struct({
        kid: Schema.String,
        rotatedAt: Schema.DateTimeUtcFromString,
        retiresAt: Schema.DateTimeUtcFromString,
      }),
      Result: SigningKeyRow,
      execute: (r) => sql`
          UPDATE jwt_signing_key SET rotatedAt = ${r.rotatedAt}, retiresAt = ${r.retiresAt}
          WHERE kid = ${r.kid}
          RETURNING *
        `,
    });

    const create: SigningKeyRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const now = yield* DateTime.now;
      const row = yield* insert({
        kid: input.kid,
        alg: input.alg,
        publicKeyJwk: JSON.stringify(input.publicKeyJwk),
        privateKeyJwk: Option.match(input.privateKeyJwk, {
          onNone: () => null,
          onSome: (redacted) => JSON.stringify(Redacted.value(redacted)),
        }),
        createdAt: now,
      }).pipe(Effect.orDie);
      return toRecord(row);
    });

    const findCurrent: SigningKeyRecordsShape["findCurrent"] = () =>
      findCurrentQuery(undefined).pipe(Effect.map(Option.map(toRecord)), Effect.orDie);

    const listVerifiable: SigningKeyRecordsShape["listVerifiable"] = (now) =>
      listVerifiableQuery(now).pipe(
        Effect.map((rows) => rows.map(toRecord)),
        Effect.orDie,
      );

    const markRotated: SigningKeyRecordsShape["markRotated"] = (kid, rotatedAt, retiresAt) =>
      markRotatedQuery({ kid, rotatedAt, retiresAt }).pipe(Effect.asVoid, Effect.orDie);

    return { create, findCurrent, listVerifiable, markRotated };
  }),
);
