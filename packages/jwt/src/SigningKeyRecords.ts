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
// `SealedColumn` (plan 05, ADR-EA-019 decision 6): an `Encryption` envelope whose AAD is
// `jwt_signing_key:<kid>:privateKeyJwk`, so ciphertext copied onto another row fails
// authentication, and a database dump or read replica no longer yields signing keys. Both
// adapters seal (the memory one too, so a test exercises the same mechanism), the records hand
// out `Sealed<Jwk>` and `KeyRing` opens the current key where it signs, and a key sealed under a
// retired encryption key is re-sealed on its next read. Production deployments that must keep private
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

import { Defects, type Encryption } from "@awthaq/ports";
import { Models as SqlModels, SealedColumn, StoreFailure } from "@awthaq/sql";
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
  /** Sealed; `None` under remote signing. Open it where the key signs. */
  readonly privateKeyJwk: Option.Option<SealedColumn.Sealed<Jwk>>;
  readonly createdAt: DateTime.Utc;
  readonly rotatedAt: Option.Option<DateTime.Utc>;
  readonly retiresAt: Option.Option<DateTime.Utc>;
}

/** The sealed `privateKeyJwk` column; canonical AAD already, so there is no legacy spelling. */
export const privateKeyJwkColumn = SealedColumn.column({
  table: "jwt_signing_key",
  column: "privateKeyJwk",
  key: "kid",
  schema: Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
});

/** A key as the memory adapter keeps it: the private half is the envelope string, like a SQL row. */
interface StoredSigningKey extends Omit<SigningKeyRecord, "privateKeyJwk"> {
  readonly privateKeyJwk: Option.Option<string>;
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
  }) => Effect.Effect<SigningKeyRecord, CurrentKeyConflict | StoreFailure.StoreUnavailable>;
  /** The row with no `rotatedAt` yet — the one currently used to sign new tokens, if any exists. */
  readonly findCurrent: () => Effect.Effect<
    Option.Option<SigningKeyRecord>,
    StoreFailure.StoreUnavailable
  >;
  /** Every row not yet past its `retiresAt` (rows with no `retiresAt` at all included). */
  readonly listVerifiable: (
    now: DateTime.Utc,
  ) => Effect.Effect<ReadonlyArray<SigningKeyRecord>, StoreFailure.StoreUnavailable>;
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
  ) => Effect.Effect<boolean, StoreFailure.StoreUnavailable>;
  /**
   * N12/KRS-008: shortens an already-rotated key's grace period to end at
   * `retiresAt` — the "this key is compromised, stop trusting it now" lever.
   * Never lengthens a grace period and never touches a current key; resolves
   * `true` only when a row actually changed.
   */
  readonly retire: (
    kid: string,
    retiresAt: DateTime.Utc,
  ) => Effect.Effect<boolean, StoreFailure.StoreUnavailable>;
}

export class SigningKeyRecords extends Context.Service<SigningKeyRecords, SigningKeyRecordsShape>()(
  "awthaq/jwt/records/SigningKeyRecords",
) {}

const newestFirst = <A extends { readonly createdAt: DateTime.Utc }>(
  records: ReadonlyArray<A>,
): ReadonlyArray<A> =>
  [...records].sort(
    (a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt),
  );

const isVerifiable = (
  record: { readonly retiresAt: Option.Option<DateTime.Utc> },
  now: DateTime.Utc,
): boolean =>
  Option.match(record.retiresAt, {
    onNone: () => true,
    onSome: (retiresAt) => DateTime.toEpochMillis(retiresAt) > DateTime.toEpochMillis(now),
  });

// ---- layerMemory ------------------------------------------------------------

type RecordsState = HashMap.HashMap<string, StoredSigningKey>;

/**
 * A test seam of `layerMemory`: the stored envelope of the sealed column, and a way to overwrite it
 * (`TestAuth.runSealedColumnTests` needs to look at, and plant, what is at rest; over SQL that is a
 * statement, over memory it is this).
 */
export class MemoryEnvelopes extends Context.Service<
  MemoryEnvelopes,
  {
    readonly stored: (kid: string) => Effect.Effect<string>;
    readonly plant: (kid: string, stored: string) => Effect.Effect<void>;
  }
>()("awthaq/jwt/SigningKeyRecords/MemoryEnvelopes") {}

// The explicit types on `layerMemory` and `layerSql` are the narrow exception the plugins document
// (TS2883): declaration emit cannot name `Encryption` through the sealed-column codec's requirement.
export const layerMemory: Layer.Layer<
  SigningKeyRecords | MemoryEnvelopes,
  never,
  Encryption.Encryption
> = Layer.effectContext(
  Effect.gen(function* () {
    const state = yield* Ref.make<RecordsState>(HashMap.empty());

    /** Persists a re-seal only while the row still holds the envelope that was read. */
    const swap: SealedColumn.Swap = (rowKey, stored, fresh) =>
      Ref.modify(state, (s) => {
        const row = HashMap.get(s, rowKey);
        if (Option.isNone(row) || Option.getOrUndefined(row.value.privateKeyJwk) !== stored) {
          return [false, s] as const;
        }
        return [
          true,
          HashMap.set(s, rowKey, { ...row.value, privateKeyJwk: Option.some(fresh) }),
        ] as const;
      });
    const privateKeys = yield* SealedColumn.codec(privateKeyJwkColumn, swap);
    const toRecord = (row: StoredSigningKey): SigningKeyRecord => ({
      ...row,
      privateKeyJwk: Option.map(row.privateKeyJwk, (stored) => privateKeys.sealed(row.kid, stored)),
    });

    const create: SigningKeyRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const now = yield* DateTime.now;
      const privateKeyJwk = yield* Option.match(input.privateKeyJwk, {
        onNone: () => Effect.succeed(Option.none<string>()),
        onSome: (redacted) => Effect.map(privateKeys.seal(input.kid, redacted), Option.some),
      });
      const record: StoredSigningKey = {
        kid: input.kid,
        alg: input.alg,
        publicKeyJwk: input.publicKeyJwk,
        privateKeyJwk,
        createdAt: now,
        rotatedAt: Option.fromNullishOr(input.rotated?.rotatedAt),
        retiresAt: Option.fromNullishOr(input.rotated?.retiresAt),
      };
      // One atomic step: the single-current check and the insert.
      return yield* Ref.modify(
        state,
        (s): readonly [Result.Result<StoredSigningKey, CurrentKeyConflict>, RecordsState] =>
          Option.isNone(record.rotatedAt) &&
          Array.from(HashMap.values(s)).some((row) => Option.isNone(row.rotatedAt))
            ? [Result.fail(new CurrentKeyConflict({ kid: record.kid })), s]
            : [Result.succeed(record), HashMap.set(s, record.kid, record)],
      ).pipe(Effect.flatMap(Effect.fromResult), Effect.map(toRecord));
    });

    const findCurrent: SigningKeyRecordsShape["findCurrent"] = () =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          newestFirst(Array.from(HashMap.values(s))).find((row) => Option.isNone(row.rotatedAt)),
        ),
        Effect.map((row) => Option.map(Option.fromNullishOr(row), toRecord)),
      );

    const listVerifiable: SigningKeyRecordsShape["listVerifiable"] = (now) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          newestFirst(Array.from(HashMap.values(s)))
            .filter((row) => isVerifiable(row, now))
            .map(toRecord),
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

    const records = { create, findCurrent, listVerifiable, markRotated, retire };
    const envelopes = MemoryEnvelopes.of({
      stored: (kid) =>
        Effect.map(Ref.get(state), (s) =>
          Option.getOrElse(
            Option.flatMap(HashMap.get(s, kid), (row) => row.privateKeyJwk),
            () => "",
          ),
        ),
      plant: (kid, stored) =>
        Ref.update(state, (s) =>
          Option.match(HashMap.get(s, kid), {
            onNone: () => s,
            onSome: (row) => HashMap.set(s, kid, { ...row, privateKeyJwk: Option.some(stored) }),
          }),
        ),
    });
    return Context.make(SigningKeyRecords, records).pipe(Context.add(MemoryEnvelopes, envelopes));
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

export const layerSql: Layer.Layer<
  SigningKeyRecords,
  never,
  SqlClient.SqlClient | Encryption.Encryption
> = Layer.effect(
  SigningKeyRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const SigningKeyRow = makeSigningKeyRow(wire);
    const unavailable = (operation: string) =>
      StoreFailure.orStoreUnavailable(`SigningKeyRecords.${operation}`);
    const privateKeys = yield* SealedColumn.codec(
      privateKeyJwkColumn,
      yield* SealedColumn.sqlSwap(privateKeyJwkColumn),
    );

    // A public key that no longer decodes is a deployment fault (a tampered or swapped row),
    // not something a caller can recover from, so it dies with a clear message. The private half
    // is not decoded here: it is sealed and opens where the key signs (`SealedColumn.orDie`).
    const unreadable = (kid: string) => () =>
      Defects.invariantViolation(
        "SigningKeyUndecodable",
        `awthaq/jwt: the public key of signing key "${kid}" could not be decoded`,
      );

    const decodeRow = Effect.fnUntraced(function* (row: SigningKeyRow) {
      const publicKeyJwk = yield* Schema.decodeUnknownEffect(JwkJson)(row.publicKeyJwk).pipe(
        Effect.catch(unreadable(row.kid)),
      );
      const record: SigningKeyRecord = {
        kid: row.kid,
        alg: row.alg,
        publicKeyJwk,
        privateKeyJwk: Option.map(Option.fromNullishOr(row.privateKeyJwk), (stored) =>
          privateKeys.sealed(row.kid, stored),
        ),
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
            (kid, alg, "publicKeyJwk", "privateKeyJwk", "createdAt", "rotatedAt", "retiresAt")
          VALUES
            (${r.kid}, ${r.alg}, ${r.publicKeyJwk}, ${r.privateKeyJwk}, ${r.createdAt}, ${r.rotatedAt}, ${r.retiresAt})
          RETURNING *
        `,
    });

    const findCurrentQuery = SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: SigningKeyRow,
      execute: () => sql`
          SELECT * FROM jwt_signing_key WHERE "rotatedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1
        `,
    });

    const listVerifiableQuery = SqlSchema.findAll({
      Request: wire.dateTime,
      Result: SigningKeyRow,
      execute: (now) => sql`
          SELECT * FROM jwt_signing_key
          WHERE "retiresAt" IS NULL OR "retiresAt" > ${now}
          ORDER BY "createdAt" DESC
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
          UPDATE jwt_signing_key SET "rotatedAt" = ${r.rotatedAt}, "retiresAt" = ${r.retiresAt}
          WHERE kid = ${r.kid} AND "rotatedAt" IS NULL
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
          UPDATE jwt_signing_key SET "retiresAt" = ${r.retiresAt}
          WHERE kid = ${r.kid} AND "rotatedAt" IS NOT NULL
            AND ("retiresAt" IS NULL OR "retiresAt" > ${r.retiresAt})
          RETURNING *
        `,
    });

    const create: SigningKeyRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const now = yield* DateTime.now;
      const privateKeyJwk = yield* Option.match(input.privateKeyJwk, {
        onNone: () => Effect.succeed(null),
        onSome: (redacted) => privateKeys.seal(input.kid, redacted),
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
        input.rotated === undefined
          ? StoreFailure.orConflict(
              "SigningKeyRecords.create",
              () => new CurrentKeyConflict({ kid: input.kid }),
            )
          : unavailable("create"),
      );
      return yield* decodeRow(row);
    });

    const findCurrent: SigningKeyRecordsShape["findCurrent"] = () =>
      findCurrentQuery(undefined).pipe(
        unavailable("findCurrent"),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (row) => Effect.map(decodeRow(row), Option.some),
          }),
        ),
      );

    const listVerifiable: SigningKeyRecordsShape["listVerifiable"] = (now) =>
      listVerifiableQuery(now).pipe(
        unavailable("listVerifiable"),
        Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
      );

    const markRotated: SigningKeyRecordsShape["markRotated"] = (kid, rotatedAt, retiresAt) =>
      markRotatedQuery({ kid, rotatedAt, retiresAt }).pipe(
        Effect.map(Option.isSome),
        unavailable("markRotated"),
      );

    const retire: SigningKeyRecordsShape["retire"] = (kid, retiresAt) =>
      retireQuery({ kid, retiresAt }).pipe(Effect.map(Option.isSome), unavailable("retire"));

    return { create, findCurrent, listVerifiable, markRotated, retire };
  }),
);

/**
 * Plan 08 (BEH-EA-T4): the signing-key store as a layer that provides the record store only. `layerMemory`
 * also provides `MemoryEnvelopes`, a test seam that is not a store; a bundle provides record stores only, so it
 * is projected away here (a suite that plants envelopes uses `layerMemory` directly).
 */
export const layerMemoryStore: Layer.Layer<SigningKeyRecords, never, Encryption.Encryption> =
  Layer.effect(SigningKeyRecords, Effect.service(SigningKeyRecords)).pipe(
    Layer.provide(layerMemory),
  );
