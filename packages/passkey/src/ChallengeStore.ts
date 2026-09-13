// @awthaq/passkey — ChallengeStore
//
// spec/behaviors/17-passkey.md, BEH-EA-132. Plugin-owned, not
// `@awthaq/ports` — only this plugin needs it (this module's own
// header explains why WebAuthn itself, in contrast, is a shared port).
//
// Three `Layer`s over the same `ChallengeStoreShape`, per the "richness
// over complexity" decision made during this feature's own design session:
// no forced single default — an application picks whichever backend fits
// its deployment.
//
// - `layerMemory` — a `Ref`, for a single-process deployment or tests.
// - `layerSql` — its own `passkey_challenge` table, claimed with the same
//   atomic-single-statement technique `spec/decisions/016-verification-sql-claiming.md`
//   (ADR-EA-016) established for `Verification`: `issue` is one
//   `INSERT ... ON CONFLICT(scope) DO UPDATE ... RETURNING`, and `consume`
//   is one `DELETE ... RETURNING` — the row is gone the instant either
//   statement runs, so two concurrent callers can never both observe a
//   still-live row for the same scope.
// - `layerCookie` — a stateless, HMAC-signed value with **no server-side
//   storage at all**. This is a real, documented trade-off, not an
//   oversight: BEH-EA-132's own "deleted on every verification attempt...
//   regardless of whether that attempt succeeds" is a genuine *statefulness*
//   requirement (something has to remember "this one was already used"),
//   which a value with no storage behind it structurally cannot enforce —
//   only its TTL bounds how long a captured value stays replayable. Suited
//   to edge/serverless deployments with no shared store available to the
//   request, willing to accept that narrower guarantee in exchange for
//   needing none.
//
// The value `issue` returns is always a base64url string — the exact shape
// `@awthaq/ports`' `WebAuthn` port expects to decode straight into a
// challenge's raw bytes (see that module's own header comment on why a
// bare string is never treated as UTF-8 text there).

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { SqlClient, SqlSchema } from "effect/unstable/sql";

/** BEH-EA-132: e.g. `registration:<sessionId>`, `authentication:<nonce>` — the plugin's own concern, opaque here. */
export type ChallengeScope = string;

/** BEH-EA-132: five minutes, non-configurable — the one value the behavior itself fixes. */
const TTL = Duration.minutes(5);
const RANDOM_BYTES = 32;

export interface ChallengeStoreShape {
  /** Mints a fresh challenge scoped to `scope`, replacing whatever this scope's own prior (unconsumed) challenge was, if any. */
  readonly issue: (scope: ChallengeScope) => Effect.Effect<Redacted.Redacted<string>>;
  /** BEH-EA-132: `true` only for the exact value just issued for `scope`, while unexpired — `false`, and the entry gone either way, for every other outcome. */
  readonly consume: (scope: ChallengeScope, challenge: string) => Effect.Effect<boolean>;
}

export class ChallengeStore extends Context.Service<ChallengeStore, ChallengeStoreShape>()(
  "awthaq/passkey/ChallengeStore",
) {}

// ---- layerMemory ----------------------------------------------------------

interface MemoryEntry {
  readonly value: string;
  readonly expiresAt: DateTime.Utc;
}

export const layerMemory: Layer.Layer<ChallengeStore, never, Crypto.Crypto> = Layer.effect(
  ChallengeStore,
  Effect.gen(function* () {
    const state = yield* Ref.make(HashMap.empty<ChallengeScope, MemoryEntry>());
    const crypto = yield* Crypto.Crypto;

    const issue: ChallengeStoreShape["issue"] = Effect.fnUntraced(function* (scope) {
      const value = Encoding.encodeBase64Url(
        yield* crypto.randomBytes(RANDOM_BYTES).pipe(Effect.orDie),
      );
      const now = yield* DateTime.now;
      yield* Ref.update(state, (s) =>
        HashMap.set(s, scope, { value, expiresAt: DateTime.addDuration(now, TTL) }),
      );
      return Redacted.make(value);
    });

    const consume: ChallengeStoreShape["consume"] = Effect.fnUntraced(function* (scope, challenge) {
      // BEH-EA-132: popped unconditionally in one atomic step — gone whether or not it turns out to match.
      const popped = yield* Ref.modify(
        state,
        (s) => [HashMap.get(s, scope), HashMap.remove(s, scope)] as const,
      );
      if (Option.isNone(popped)) return false;
      const now = yield* DateTime.now;
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(popped.value.expiresAt))
        return false;
      return popped.value.value === challenge;
    });

    return { issue, consume };
  }),
);

// ---- layerSql ---------------------------------------------------------------

const ChallengeRow = Schema.Struct({
  scope: Schema.String,
  value: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
});

export const layerSql: Layer.Layer<ChallengeStore, never, SqlClient.SqlClient | Crypto.Crypto> =
  Layer.effect(
    ChallengeStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const crypto = yield* Crypto.Crypto;

      /**
       * ADR-EA-016's technique: one atomic upsert. `scope` is this table's
       * own primary key, so an ordinary (non-partial) `ON CONFLICT` already
       * targets the single live row for it — there is no consumed-history
       * to preserve the way `verification_tokens`' partial index does,
       * since a consumed challenge is deleted outright, not marked.
       */
      const upsert = SqlSchema.findOne({
        Request: Schema.Struct({
          scope: Schema.String,
          value: Schema.String,
          expiresAt: Schema.DateTimeUtcFromString,
          createdAt: Schema.DateTimeUtcFromString,
        }),
        Result: ChallengeRow,
        execute: (request) => sql`
          INSERT INTO passkey_challenge (scope, value, expiresAt, createdAt)
          VALUES (${request.scope}, ${request.value}, ${request.expiresAt}, ${request.createdAt})
          ON CONFLICT(scope) DO UPDATE SET
            value = excluded.value,
            expiresAt = excluded.expiresAt,
            createdAt = excluded.createdAt
          RETURNING scope, value, expiresAt
        `,
      });

      /** BEH-EA-132: one atomic `DELETE ... RETURNING` — the row is gone the instant this statement runs, whether or not the caller's presented value goes on to match. */
      const popByScope = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: ChallengeRow,
        execute: (scope) => sql`
          DELETE FROM passkey_challenge WHERE scope = ${scope}
          RETURNING scope, value, expiresAt
        `,
      });

      const issue: ChallengeStoreShape["issue"] = Effect.fnUntraced(function* (scope) {
        const value = Encoding.encodeBase64Url(
          yield* crypto.randomBytes(RANDOM_BYTES).pipe(Effect.orDie),
        );
        const now = yield* DateTime.now;
        yield* upsert({
          scope,
          value,
          expiresAt: DateTime.addDuration(now, TTL),
          createdAt: now,
        }).pipe(Effect.orDie);
        return Redacted.make(value);
      });

      const consume: ChallengeStoreShape["consume"] = Effect.fnUntraced(
        function* (scope, challenge) {
          const popped = yield* popByScope(scope).pipe(Effect.orDie);
          if (Option.isNone(popped)) return false;
          const now = yield* DateTime.now;
          if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(popped.value.expiresAt))
            return false;
          return popped.value.value === challenge;
        },
      );

      return { issue, consume };
    }),
  );

// ---- layerCookie --------------------------------------------------------

/** BEH-EA-075's own `Csrf.ts` HMAC — copied rather than imported: this plugin does not depend on `@awthaq/server`, and the primitive is small enough that duplicating it costs less than the cross-stratum dependency would. */
const SHA256_BLOCK_SIZE = 64;

const concatBytes = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const hmacSha256 = (
  crypto: Crypto.Crypto,
  key: Uint8Array,
  message: Uint8Array,
): Effect.Effect<Uint8Array> =>
  Effect.gen(function* () {
    let blockKey = key.length > SHA256_BLOCK_SIZE ? yield* crypto.digest("SHA-256", key) : key;
    if (blockKey.length < SHA256_BLOCK_SIZE) {
      const padded = new Uint8Array(SHA256_BLOCK_SIZE);
      padded.set(blockKey);
      blockKey = padded;
    }
    const ipad = new Uint8Array(SHA256_BLOCK_SIZE);
    const opad = new Uint8Array(SHA256_BLOCK_SIZE);
    for (let i = 0; i < SHA256_BLOCK_SIZE; i++) {
      const keyByte = blockKey[i] ?? 0;
      ipad[i] = keyByte ^ 0x36;
      opad[i] = keyByte ^ 0x5c;
    }
    const inner = yield* crypto.digest("SHA-256", concatBytes(ipad, message));
    return yield* crypto.digest("SHA-256", concatBytes(opad, inner));
  }).pipe(Effect.orDie);

const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

export interface ChallengeCookieConfigShape {
  /** Signs every issued value; never defaulted, the same posture `@awthaq/server`'s `CsrfConfig.secret` takes. */
  readonly secret: Redacted.Redacted<string>;
}

export class ChallengeCookieConfig extends Context.Service<
  ChallengeCookieConfig,
  ChallengeCookieConfigShape
>()("awthaq/passkey/ChallengeCookieConfig") {}

const PAYLOAD_BYTES = RANDOM_BYTES + 8;
const HMAC_BYTES = 32;
const TOTAL_BYTES = PAYLOAD_BYTES + HMAC_BYTES;

const packExpiry = (expiresAt: DateTime.Utc): Uint8Array => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(DateTime.toEpochMillis(expiresAt)), false);
  return bytes;
};

const unpackExpiryMillis = (bytes: Uint8Array): number =>
  Number(new DataView(bytes.slice().buffer).getBigUint64(0, false));

/**
 * `layerCookie`: see this module's own header comment for the real,
 * documented trade-off (bounded by TTL, not truly single-use). Requires no
 * ambient HTTP request/response access — the returned value is entirely
 * self-verifying, so it round-trips however the caller's own ceremony
 * already carries the WebAuthn challenge back and forth (typically: simply
 * as that challenge itself, requiring no separate cookie at all).
 */
export const layerCookie: Layer.Layer<
  ChallengeStore,
  never,
  Crypto.Crypto | ChallengeCookieConfig
> = Layer.effect(
  ChallengeStore,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const config = yield* ChallengeCookieConfig;
    const secretBytes = new TextEncoder().encode(Redacted.value(config.secret));

    const sign = (scope: ChallengeScope, payload: Uint8Array) =>
      hmacSha256(crypto, secretBytes, concatBytes(new TextEncoder().encode(scope), payload));

    const issue: ChallengeStoreShape["issue"] = Effect.fnUntraced(function* (scope) {
      const random = yield* crypto.randomBytes(RANDOM_BYTES).pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const payload = concatBytes(random, packExpiry(DateTime.addDuration(now, TTL)));
      const signature = yield* sign(scope, payload);
      return Redacted.make(Encoding.encodeBase64Url(concatBytes(payload, signature)));
    });

    const consume: ChallengeStoreShape["consume"] = Effect.fnUntraced(function* (scope, challenge) {
      const decoded = Encoding.decodeBase64Url(challenge);
      if (Result.isFailure(decoded)) return false;
      const bytes = decoded.success;
      if (bytes.length !== TOTAL_BYTES) return false;
      const payload = bytes.slice(0, PAYLOAD_BYTES);
      const signature = bytes.slice(PAYLOAD_BYTES);
      const expected = yield* sign(scope, payload);
      if (!constantTimeEqual(signature, expected)) return false;
      const now = yield* DateTime.now;
      return DateTime.toEpochMillis(now) < unpackExpiryMillis(payload.slice(RANDOM_BYTES));
    });

    return { issue, consume };
  }),
);
