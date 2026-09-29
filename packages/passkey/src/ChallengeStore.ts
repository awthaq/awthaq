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

import { Hmac } from "@awthaq/ports";
import { Models as SqlModels } from "@awthaq/sql";
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
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { concatBytes, constantTimeEqual, hmacSha256 } from "./Hmac.ts";

/** BEH-EA-132: e.g. `registration:<sessionId>`, `authentication:<nonce>` — the plugin's own concern, opaque here. */
export type ChallengeScope = string;

/** BEH-EA-132: five minutes, non-configurable — the one value the behavior itself fixes. Exported so `PasskeyConfig.ceremonyTimeout` (TC-003) can be validated against it. */
export const CHALLENGE_TTL = Duration.minutes(5);
const TTL = CHALLENGE_TTL;
const RANDOM_BYTES = 32;

/**
 * WPS-009: what a backend really promises, stated in the type so a host
 * (and `Passkey.layer`, which warns at build time) can see it instead of
 * reading prose. `layerMemory`/`layerSql` claim both; `layerCookie` is
 * stateless and structurally cannot (see this module's own header).
 */
export interface ChallengeStoreGuarantees {
  /** A consumed (or failed-attempt) challenge can never be consumed again. */
  readonly singleUse: boolean;
  /** Issuing for a scope invalidates that scope's prior, unconsumed challenge. */
  readonly replacesPriorOnIssue: boolean;
}

export interface ChallengeStoreShape {
  readonly guarantees: ChallengeStoreGuarantees;
  /** Mints a fresh challenge scoped to `scope`. When `guarantees.replacesPriorOnIssue`, replaces whatever this scope's own prior (unconsumed) challenge was, if any. Also reclaims expired entries (WPS-005). */
  readonly issue: (scope: ChallengeScope) => Effect.Effect<Redacted.Redacted<string>>;
  /** BEH-EA-132: `true` only for the exact value just issued for `scope`, while unexpired — `false`, and (when `guarantees.singleUse`) the entry gone either way, for every other outcome. */
  readonly consume: (scope: ChallengeScope, challenge: string) => Effect.Effect<boolean>;
  /** WPS-005: removes every expired, never-consumed challenge and answers how many it removed, so a host can schedule reclamation. Stateless stores answer `0`. */
  readonly sweepExpired: Effect.Effect<number>;
}

export class ChallengeStore extends Context.Service<ChallengeStore, ChallengeStoreShape>()(
  "awthaq/passkey/ChallengeStore",
) {}

const isExpired = (expiresAt: DateTime.Utc, now: DateTime.Utc): boolean =>
  DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(expiresAt);

const STATEFUL_GUARANTEES: ChallengeStoreGuarantees = {
  singleUse: true,
  replacesPriorOnIssue: true,
};

/**
 * BPAS-008 (+CB-007/WPS-008/HSK-010): the final comparison of a stored
 * challenge against a presented one runs over decoded bytes in constant time
 * (the same `constantTimeEqual` `layerCookie` already used), never `===`. A
 * presented value that is not base64url is simply not a match.
 */
const challengeMatches = (stored: string, presented: string): boolean => {
  const storedBytes = Encoding.decodeBase64Url(stored);
  const presentedBytes = Encoding.decodeBase64Url(presented);
  if (Result.isFailure(storedBytes) || Result.isFailure(presentedBytes)) return false;
  return constantTimeEqual(storedBytes.success, presentedBytes.success);
};

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
      // WPS-005: drop every already-expired entry in the same atomic update
      // (bounded by the live set, since anything older than the TTL is gone).
      yield* Ref.update(state, (s) =>
        HashMap.set(
          HashMap.filter(s, (entry) => !isExpired(entry.expiresAt, now)),
          scope,
          { value, expiresAt: DateTime.addDuration(now, TTL) },
        ),
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
      if (isExpired(popped.value.expiresAt, now)) return false;
      return challengeMatches(popped.value.value, challenge);
    });

    const sweepExpired: ChallengeStoreShape["sweepExpired"] = Effect.gen(function* () {
      const now = yield* DateTime.now;
      return yield* Ref.modify(state, (s) => {
        const live = HashMap.filter(s, (entry) => !isExpired(entry.expiresAt, now));
        return [HashMap.size(s) - HashMap.size(live), live] as const;
      });
    });

    return { guarantees: STATEFUL_GUARANTEES, issue, consume, sweepExpired };
  }),
);

// ---- layerSql ---------------------------------------------------------------

const makeChallengeRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    scope: Schema.String,
    value: Schema.String,
    expiresAt: wire.dateTime,
  });

export const layerSql: Layer.Layer<ChallengeStore, never, SqlClient.SqlClient | Crypto.Crypto> =
  Layer.effect(
    ChallengeStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
      const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
      const ChallengeRow = makeChallengeRow(wire);
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
          expiresAt: wire.dateTime,
          createdAt: wire.dateTime,
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

      /** WPS-005: `expiresAt` is indexed (`create_passkey_challenge_expires_at_index`), so this stays a range scan. */
      const deleteExpired = SqlSchema.findAll({
        Request: wire.dateTime,
        Result: Schema.Struct({ scope: Schema.String }),
        execute: (now) => sql`
          DELETE FROM passkey_challenge WHERE expiresAt <= ${now}
          RETURNING scope
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
        // WPS-005: abandoned (anonymous, never-consumed) ceremonies would
        // otherwise accumulate forever — reclaim them on every issue.
        yield* deleteExpired(now).pipe(Effect.orDie);
        return Redacted.make(value);
      });

      const consume: ChallengeStoreShape["consume"] = Effect.fnUntraced(
        function* (scope, challenge) {
          const popped = yield* popByScope(scope).pipe(Effect.orDie);
          if (Option.isNone(popped)) return false;
          const now = yield* DateTime.now;
          if (isExpired(popped.value.expiresAt, now)) return false;
          return challengeMatches(popped.value.value, challenge);
        },
      );

      const sweepExpired: ChallengeStoreShape["sweepExpired"] = Effect.gen(function* () {
        const now = yield* DateTime.now;
        const removed = yield* deleteExpired(now).pipe(Effect.orDie);
        return removed.length;
      });

      return { guarantees: STATEFUL_GUARANTEES, issue, consume, sweepExpired };
    }),
  );

// ---- layerCookie --------------------------------------------------------

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
    // ACS-007: no composition may sign challenges with a guessable key.
    yield* Hmac.requireMinSecretBytes(config.secret);
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
      if (!Hmac.constantTimeEqualBytes(signature, expected)) return false;
      const now = yield* DateTime.now;
      return DateTime.toEpochMillis(now) < unpackExpiryMillis(payload.slice(RANDOM_BYTES));
    });

    return {
      // WPS-009: nothing is stored, so neither property is enforceable; only the TTL bounds a captured value.
      guarantees: { singleUse: false, replacesPriorOnIssue: false },
      issue,
      consume,
      sweepExpired: Effect.succeed(0),
    };
  }),
);
