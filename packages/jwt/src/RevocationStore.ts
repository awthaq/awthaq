// @awthaq/jwt — RevocationStore
//
// .scratch/resolve-ready-for-human-findings/issues/11-token-lifecycle-store.md
// (TRBS-001/TIR-001/MAPS-002). A `jti`-keyed denylist — `Jwt.ts`'s stateless
// `verify`/`verifyJWT` stay untouched (still `R = never`, still documented
// as revocation-lagging by design, still the fast/cheap path); `introspect`/
// `introspectLive` are the new, opt-in path that consults this store.
//
// `layerMemory`/`layerSql` mirrors `Sessions`' own backend-neutral-port
// split (ADR-EA-014), built directly against `effect/unstable/sql`'s
// `SqlSchema` for the SQL side — the same plugin-owned-table pattern
// `SigningKeyRecords.ts` already established in this package (this table
// belongs to `@awthaq/jwt`, not the shared persistence stratum).
//
// `isRevoked` applies `Verification.ts`'s own lazy-expiry-on-read
// convention: a row past its own `expiresAt` is treated as absent, no
// separate cleanup job. `revoke` is always called with the token's own
// `exp` as the row's `expiresAt`, so a denylist entry never outlives the
// token it denies.
//
// No call site exists in this codebase yet for `revoke` itself — the same
// "forward-looking plumbing, fixed correctly now rather than retrofitted
// later" posture this same decision ticket already accepted for
// `Sessions.issue`'s `supersedes`. An application composing `Jwt` calls
// `revoke` directly (this service is exported, not wrapped by `JwtShape`
// — the same standalone-export shape `KeyRing.rotateNow` already uses)
// with a `jti` it extracted from `jwt.verify`/`verifyJWT`'s own claims.

import { Models as SqlModels } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export interface RevocationStoreShape {
  readonly revoke: (jti: string, expiresAt: DateTime.Utc) => Effect.Effect<void>;
  readonly isRevoked: (jti: string) => Effect.Effect<boolean>;
}

export class RevocationStore extends Context.Service<RevocationStore, RevocationStoreShape>()(
  "awthaq/jwt/RevocationStore",
) {}

// ---- layerMemory ------------------------------------------------------------

type RevocationState = HashMap.HashMap<string, DateTime.Utc>;

export const layerMemory = Layer.effect(
  RevocationStore,
  Effect.gen(function* () {
    const state = yield* Ref.make<RevocationState>(HashMap.empty());

    const revoke: RevocationStoreShape["revoke"] = (jti, expiresAt) =>
      Ref.update(state, (s) => HashMap.set(s, jti, expiresAt));

    const isRevoked: RevocationStoreShape["isRevoked"] = (jti) =>
      Effect.gen(function* () {
        const s = yield* Ref.get(state);
        const entry = HashMap.get(s, jti);
        if (Option.isNone(entry)) return false;
        const now = yield* DateTime.now;
        return DateTime.toEpochMillis(entry.value) > DateTime.toEpochMillis(now);
      });

    return { revoke, isRevoked };
  }),
);

// ---- layerSql -----------------------------------------------------------------

const makeRevocationRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    jti: Schema.String,
    expiresAt: wire.dateTime,
  });

export const layerSql = Layer.effect(
  RevocationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const RevocationRow = makeRevocationRow(wire);

    const upsert = SqlSchema.findOne({
      Request: RevocationRow,
      Result: RevocationRow,
      execute: (r) => sql`
          INSERT INTO jwt_token_revocation (jti, "expiresAt")
          VALUES (${r.jti}, ${r.expiresAt})
          ON CONFLICT (jti) DO UPDATE SET "expiresAt" = excluded."expiresAt"
          RETURNING *
        `,
    });

    const findQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: RevocationRow,
      execute: (jti) => sql`SELECT * FROM jwt_token_revocation WHERE jti = ${jti}`,
    });

    const revoke: RevocationStoreShape["revoke"] = (jti, expiresAt) =>
      upsert({ jti, expiresAt }).pipe(Effect.asVoid, Effect.orDie);

    const isRevoked: RevocationStoreShape["isRevoked"] = (jti) =>
      Effect.gen(function* () {
        const row = yield* findQuery(jti).pipe(Effect.orDie);
        if (Option.isNone(row)) return false;
        const now = yield* DateTime.now;
        return DateTime.toEpochMillis(row.value.expiresAt) > DateTime.toEpochMillis(now);
      });

    return { revoke, isRevoked };
  }),
);
