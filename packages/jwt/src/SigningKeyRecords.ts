// @awthaq/jwt — SigningKeyRecords
//
// .scratch/jwt/spec.md's "Key management" decision. This plugin's own
// persistence for the `jwt_signing_key` table — built directly against
// `effect/unstable/sql`'s `SqlSchema`, the same way
// `@awthaq/admin`'s own `ImpersonationRecords.ts` builds
// `admin_impersonation`: this table belongs to the plugin, not the shared
// persistence stratum.
//
// `privateKeyJwk` is `Option.Option<Redacted.Redacted<...>>` — `None` under
// a remote-signing configuration (ticket 15's `KeyRing.registerRemoteKey`),
// `Some` under local signing (ticket 07's `mint`). The public JWK is stored
// as JSON text and decoded with `Schema.fromJsonString`, never a raw
// `JSON.parse`. KRS-001/SMS-001: `layerSql` stores the *private* JWK as an
// `@awthaq/ports` `Encryption` envelope, its AAD bound to the row's own `kid`
// (so ciphertext copied onto another row fails authentication), never as JWK
// JSON — a database dump or read replica no longer yields signing keys.
// `layerMemory` keeps the JWK in process memory unencrypted; it exists for
// tests and single-process use. Production deployments that must keep private
// material out of the database entirely register a remote (KMS/HSM) key via
// `KeyRing.registerRemoteKey` with a `JwtCodec.RemoteSigner`.
//
// `findCurrent`/`listVerifiable` were all ticket 07 needed. `markRotated`
// (ticket 11) sets `rotatedAt`/`retiresAt` on a row — after this, that row
// no longer satisfies `findCurrent`'s "no `rotatedAt` yet" predicate, so
// the next `create` becomes the new current key automatically; it keeps
// satisfying `listVerifiable` until `retiresAt` elapses, via the same
// `isVerifiable` filter already in place.
//
// JJS-004/KRS-009: at most one row is current (`rotatedAt` unset) at any
// time, enforced by the store itself — a partial unique index in `layerSql`
// (`Jwt.ts`'s `create_jwt_signing_key_single_current_index` migration), an
// atomic check in `layerMemory`. `create` of a second current key fails with
// `CurrentKeyConflict` (the caller re-reads and adopts the winner), and
// `markRotated` only applies to a row that is still current and reports
// whether it did, so a second rotator can neither mint a duplicate current
// key nor re-extend a grace period that already started.

import { Encryption } from "@awthaq/ports";
import { Models as SqlModels } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { AlgorithmLiterals } from "./JwtCodec.ts";
import type { Algorithm } from "./JwtCodec.ts";

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

/** JJS-004: another process (or fiber) already created the one current key. Re-read `findCurrent` and use it. */
export class CurrentKeyConflict extends Data.TaggedError("CurrentKeyConflict")<{
  readonly kid: string;
}> {}

export interface SigningKeyRecordsShape {
  /**
   * Inserts a key. Without `rotated` it becomes the current signing key and
   * fails with `CurrentKeyConflict` when one already exists; with `rotated` it
   * is inserted already rotated (a verification-only key, e.g. one imported
   * from another system), which never conflicts.
   */
  readonly create: (input: {
    readonly kid: string;
    readonly alg: Algorithm;
    readonly publicKeyJwk: Jwk;
    readonly privateKeyJwk: Option.Option<Redacted.Redacted<Jwk>>;
    readonly rotated?: {
      readonly rotatedAt: DateTime.Utc;
      readonly retiresAt: DateTime.Utc;
    };
  }) => Effect.Effect<SigningKeyRecord, CurrentKeyConflict>;
  /** The row with no `rotatedAt` yet — the one currently used to sign new tokens, if any exists. */
  readonly findCurrent: () => Effect.Effect<Option.Option<SigningKeyRecord>>;
  /** Every row not yet past its `retiresAt` (rows with no `retiresAt` at all included). */
  readonly listVerifiable: (now: DateTime.Utc) => Effect.Effect<ReadonlyArray<SigningKeyRecord>>;
  /**
   * Stops `kid` from being `findCurrent`'s row and starts its grace period — it
   * keeps satisfying `listVerifiable` until `retiresAt`. Applies only to a row
   * that is still current; resolves `false` when it was already rotated (so a
   * concurrent rotator never re-extends `retiresAt`).
   */
  readonly markRotated: (
    kid: string,
    rotatedAt: DateTime.Utc,
    retiresAt: DateTime.Utc,
  ) => Effect.Effect<boolean>;
  /**
   * N12/KRS-008: shortens an already-rotated key's grace period to end at
   * `retiresAt` — the "this key is compromised, stop trusting it now" lever.
   * Never lengthens a grace period and never touches a current key; resolves
   * `true` only when a row actually changed.
   */
  readonly retire: (kid: string, retiresAt: DateTime.Utc) => Effect.Effect<boolean>;
}

export class SigningKeyRecords extends Context.Service<SigningKeyRecords, SigningKeyRecordsShape>()(
  "awthaq/jwt/SigningKeyRecords",
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
        rotatedAt: Option.fromNullishOr(input.rotated?.rotatedAt),
        retiresAt: Option.fromNullishOr(input.rotated?.retiresAt),
      };
      // One atomic step: the single-current check and the insert.
      return yield* Ref.modify(
        state,
        (s): readonly [Result.Result<SigningKeyRecord, CurrentKeyConflict>, RecordsState] =>
          Option.isNone(record.rotatedAt) &&
          Array.from(HashMap.values(s)).some((row) => Option.isNone(row.rotatedAt))
            ? [Result.fail(new CurrentKeyConflict({ kid: record.kid })), s]
            : [Result.succeed(record), HashMap.set(s, record.kid, record)],
      ).pipe(Effect.flatMap(Effect.fromResult));
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
      Ref.modify(state, (s): readonly [boolean, RecordsState] => {
        const row = HashMap.get(s, kid);
        return Option.isSome(row) && Option.isNone(row.value.rotatedAt)
          ? [
              true,
              HashMap.set(s, kid, {
                ...row.value,
                rotatedAt: Option.some(rotatedAt),
                retiresAt: Option.some(retiresAt),
              }),
            ]
          : [false, s];
      });

    const retire: SigningKeyRecordsShape["retire"] = (kid, retiresAt) =>
      Ref.modify(state, (s): readonly [boolean, RecordsState] => {
        const row = HashMap.get(s, kid);
        if (Option.isNone(row) || Option.isNone(row.value.rotatedAt)) return [false, s];
        const sooner = Option.match(row.value.retiresAt, {
          onNone: () => true,
          onSome: (current) => DateTime.toEpochMillis(current) > DateTime.toEpochMillis(retiresAt),
        });
        return sooner
          ? [true, HashMap.set(s, kid, { ...row.value, retiresAt: Option.some(retiresAt) })]
          : [false, s];
      });

    return { create, findCurrent, listVerifiable, markRotated, retire };
  }),
);

// ---- layerSql -----------------------------------------------------------------

const makeSigningKeyRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    kid: Schema.String,
    alg: AlgorithmLiterals,
    publicKeyJwk: Schema.String,
    privateKeyJwk: Schema.NullOr(Schema.String),
    createdAt: wire.dateTime,
    rotatedAt: wire.nullableDateTime,
    retiresAt: wire.nullableDateTime,
  });

type SigningKeyRow = ReturnType<typeof makeSigningKeyRow>["Type"];

const JwkJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

/** KRS-001: the AAD that ties a `privateKeyJwk` envelope to the one row (and column) it belongs to. */
const privateKeyAad = (kid: string): string => `jwt_signing_key:${kid}:privateKeyJwk`;

export const layerSql = Layer.effect(
  SigningKeyRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const SigningKeyRow = makeSigningKeyRow(wire);
    const encryption = yield* Encryption.Encryption;

    // An undecryptable or malformed signing key is a deployment fault (wrong
    // or retired encryption key, tampered or swapped row), not something a
    // caller can recover from, so it dies with a clear message.
    const unreadable = (kid: string) => () =>
      Effect.die(new Error(`awthaq/jwt: signing key "${kid}" could not be decoded or decrypted`));

    const decodeRow = Effect.fnUntraced(function* (row: SigningKeyRow) {
      const publicKeyJwk = yield* Schema.decodeUnknownEffect(JwkJson)(row.publicKeyJwk).pipe(
        Effect.catch(unreadable(row.kid)),
      );
      const privateKeyJwk = yield* Option.match(Option.fromNullishOr(row.privateKeyJwk), {
        onNone: () => Effect.succeed(Option.none<Redacted.Redacted<Jwk>>()),
        onSome: (envelope) =>
          encryption.decrypt(envelope, privateKeyAad(row.kid)).pipe(
            Effect.flatMap(({ plaintext }) =>
              Schema.decodeUnknownEffect(JwkJson)(Redacted.value(plaintext)),
            ),
            Effect.map((jwk) => Option.some(Redacted.make(jwk))),
            Effect.catch(unreadable(row.kid)),
          ),
      });
      const record: SigningKeyRecord = {
        kid: row.kid,
        alg: row.alg,
        publicKeyJwk,
        privateKeyJwk,
        createdAt: row.createdAt,
        rotatedAt: Option.fromNullishOr(row.rotatedAt),
        retiresAt: Option.fromNullishOr(row.retiresAt),
      };
      return record;
    });

    const insert = SqlSchema.findOne({
      Request: Schema.Struct({
        kid: Schema.String,
        alg: AlgorithmLiterals,
        publicKeyJwk: Schema.String,
        privateKeyJwk: Schema.NullOr(Schema.String),
        createdAt: wire.dateTime,
        rotatedAt: wire.nullableDateTime,
        retiresAt: wire.nullableDateTime,
      }),
      Result: SigningKeyRow,
      execute: (r) => sql`
          INSERT INTO jwt_signing_key
            (kid, alg, publicKeyJwk, privateKeyJwk, createdAt, rotatedAt, retiresAt)
          VALUES
            (${r.kid}, ${r.alg}, ${r.publicKeyJwk}, ${r.privateKeyJwk}, ${r.createdAt}, ${r.rotatedAt}, ${r.retiresAt})
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
      Request: wire.dateTime,
      Result: SigningKeyRow,
      execute: (now) => sql`
          SELECT * FROM jwt_signing_key
          WHERE retiresAt IS NULL OR retiresAt > ${now}
          ORDER BY createdAt DESC
        `,
    });

    // JJS-004: `rotatedAt IS NULL` makes this a compare-and-swap — a second
    // rotator's UPDATE matches no row (and reports `false`) instead of
    // re-extending a grace period that already started.
    const markRotatedQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        kid: Schema.String,
        rotatedAt: wire.dateTime,
        retiresAt: wire.dateTime,
      }),
      Result: SigningKeyRow,
      execute: (r) => sql`
          UPDATE jwt_signing_key SET rotatedAt = ${r.rotatedAt}, retiresAt = ${r.retiresAt}
          WHERE kid = ${r.kid} AND rotatedAt IS NULL
          RETURNING *
        `,
    });

    // N12: only ever shortens the grace period of an already-rotated key.
    const retireQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        kid: Schema.String,
        retiresAt: wire.dateTime,
      }),
      Result: SigningKeyRow,
      execute: (r) => sql`
          UPDATE jwt_signing_key SET retiresAt = ${r.retiresAt}
          WHERE kid = ${r.kid} AND rotatedAt IS NOT NULL
            AND (retiresAt IS NULL OR retiresAt > ${r.retiresAt})
          RETURNING *
        `,
    });

    const create: SigningKeyRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const now = yield* DateTime.now;
      const privateKeyJwk = yield* Option.match(input.privateKeyJwk, {
        onNone: () => Effect.succeed(null),
        onSome: (redacted) =>
          encryption.encrypt(
            Redacted.make(JSON.stringify(Redacted.value(redacted))),
            privateKeyAad(input.kid),
          ),
      });
      const row = yield* insert({
        kid: input.kid,
        alg: input.alg,
        publicKeyJwk: JSON.stringify(input.publicKeyJwk),
        privateKeyJwk,
        createdAt: now,
        rotatedAt: input.rotated?.rotatedAt ?? null,
        retiresAt: input.rotated?.retiresAt ?? null,
      }).pipe(
        // A unique violation on a *current* key insert can only be the
        // single-current index (the kid is a fresh identifier): another
        // process minted the current key first.
        Effect.catchTags({
          SqlError: (error) =>
            error.reason._tag === "UniqueViolation" && input.rotated === undefined
              ? Effect.fail(new CurrentKeyConflict({ kid: input.kid }))
              : Effect.die(error),
          NoSuchElementError: Effect.die,
          SchemaError: Effect.die,
        }),
      );
      return yield* decodeRow(row);
    });

    const findCurrent: SigningKeyRecordsShape["findCurrent"] = () =>
      findCurrentQuery(undefined).pipe(
        Effect.orDie,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (row) => Effect.map(decodeRow(row), Option.some),
          }),
        ),
      );

    const listVerifiable: SigningKeyRecordsShape["listVerifiable"] = (now) =>
      listVerifiableQuery(now).pipe(
        Effect.orDie,
        Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
      );

    const markRotated: SigningKeyRecordsShape["markRotated"] = (kid, rotatedAt, retiresAt) =>
      markRotatedQuery({ kid, rotatedAt, retiresAt }).pipe(Effect.map(Option.isSome), Effect.orDie);

    const retire: SigningKeyRecordsShape["retire"] = (kid, retiresAt) =>
      retireQuery({ kid, retiresAt }).pipe(Effect.map(Option.isSome), Effect.orDie);

    return { create, findCurrent, listVerifiable, markRotated, retire };
  }),
);
