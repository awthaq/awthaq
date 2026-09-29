// @awthaq/passkey — PasskeyUserHandles
//
// spec/behaviors/17-passkey.md, BEH-EA-130/131. BPAS-003 (+HSK-001/TC-002/
// WPS-002/CB-005): the WebAuthn *user handle* (`user.id` in a registration's
// creation options, `userHandle` in an assertion) is one random, opaque,
// non-PII value **per user**, minted once and reused for every credential
// that user ever enrols. It used to be re-randomized at options time and
// again at verify time, so the persisted value was never the handle the
// authenticator actually bound. A discoverable credential's assertion carries
// that handle back, and a credential manager keys its whole per-account view
// on it (`signalAllAcceptedCredentials`, BPAS-006) — so it must be stable.
//
// Two `Layer`s over the same `PasskeyUserHandlesShape`, the pattern
// `PasskeyCredentials.ts` and every other domain service here follow.

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type { Users } from "@awthaq/core";
import { Models as SqlModels } from "@awthaq/sql";

type UserId = Users.UserId;

/** 64 random bytes is the WebAuthn maximum for a user handle; 32 keeps the wire small and is already unguessable. */
const HANDLE_BYTES = 32;

export interface PasskeyUserHandlesShape {
  /** The user's one stable handle (base64url of its raw bytes) — minted on first use, the same value ever after, even under concurrent first calls. */
  readonly getOrCreate: (userId: UserId) => Effect.Effect<string>;
  /** GDPR erasure (`Passkey.beforeUserDeleteErasure`): forgets the user's handle. Idempotent. */
  readonly deleteByUser: (userId: UserId) => Effect.Effect<void>;
}

export class PasskeyUserHandles extends Context.Service<
  PasskeyUserHandles,
  PasskeyUserHandlesShape
>()("awthaq/passkey/PasskeyUserHandles") {}

const randomHandle = (crypto: Crypto.Crypto): Effect.Effect<string> =>
  crypto.randomBytes(HANDLE_BYTES).pipe(Effect.map(Encoding.encodeBase64Url), Effect.orDie);

// ---- layerMemory ----------------------------------------------------------

export const layerMemory: Layer.Layer<PasskeyUserHandles, never, Crypto.Crypto> = Layer.effect(
  PasskeyUserHandles,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const state = yield* Ref.make(HashMap.empty<UserId, string>());

    const getOrCreate: PasskeyUserHandlesShape["getOrCreate"] = Effect.fnUntraced(
      function* (userId) {
        const candidate = yield* randomHandle(crypto);
        // First writer wins inside one atomic step; every later caller reads it back.
        return yield* Ref.modify(state, (s) => {
          const existing = HashMap.get(s, userId);
          if (Option.isSome(existing)) return [existing.value, s] as const;
          return [candidate, HashMap.set(s, userId, candidate)] as const;
        });
      },
    );

    const deleteByUser: PasskeyUserHandlesShape["deleteByUser"] = (userId) =>
      Ref.update(state, (s) => HashMap.remove(s, userId));

    return { getOrCreate, deleteByUser };
  }),
);

// ---- layerSql ---------------------------------------------------------------

export const layerSql: Layer.Layer<PasskeyUserHandles, never, SqlClient.SqlClient | Crypto.Crypto> =
  Layer.effect(
    PasskeyUserHandles,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
      const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
      const crypto = yield* Crypto.Crypto;

      const insertIfAbsent = SqlSchema.void({
        Request: Schema.Struct({
          userId: Schema.String,
          webauthnUserId: Schema.String,
          createdAt: wire.dateTime,
        }),
        execute: (r) => sql`
          INSERT INTO passkey_user_handle (userId, webauthnUserId, createdAt)
          VALUES (${r.userId}, ${r.webauthnUserId}, ${r.createdAt})
          ON CONFLICT(userId) DO NOTHING
        `,
      });

      const findByUser = SqlSchema.findOne({
        Request: Schema.String,
        Result: Schema.Struct({ webauthnUserId: Schema.String }),
        execute: (userId) =>
          sql`SELECT webauthnUserId FROM passkey_user_handle WHERE userId = ${userId}`,
      });

      const getOrCreate: PasskeyUserHandlesShape["getOrCreate"] = Effect.fnUntraced(
        function* (userId) {
          const candidate = yield* randomHandle(crypto);
          const now = yield* DateTime.now;
          // ON CONFLICT DO NOTHING then SELECT: whichever concurrent insert
          // won is the row every caller (including the losers) reads back.
          yield* insertIfAbsent({ userId, webauthnUserId: candidate, createdAt: now }).pipe(
            Effect.orDie,
          );
          const row = yield* findByUser(userId).pipe(Effect.orDie);
          return row.webauthnUserId;
        },
      );

      const deleteByUser: PasskeyUserHandlesShape["deleteByUser"] = (userId) =>
        sql`DELETE FROM passkey_user_handle WHERE userId = ${userId}`.pipe(
          Effect.orDie,
          Effect.asVoid,
        );

      return { getOrCreate, deleteByUser };
    }),
  );
