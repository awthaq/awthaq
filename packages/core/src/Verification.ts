// @awthaq/core — Verification
//
// spec/behaviors/08-verification-tokens.md, BEH-EA-057 through BEH-EA-064.
// Two `Layer`s over the same `VerificationShape`: `layerMemory` (a `Ref`)
// and `layerSql` (`@awthaq/sql`'s `VerificationRepository`/
// `VerificationReservationsRepository`), per
// `spec/decisions/016-verification-sql-claiming.md` (ADR-EA-016, revised
// 1.1 after a code-review finding on the original delete-then-insert
// design) — a dedicated `verification_reservations` table for `reserve`,
// claimed by a conditional upsert (`VerificationReservationsRepository.claim`);
// `issue` built on one atomic `INSERT ... ON CONFLICT ... DO UPDATE`
// against a partial unique index on `(identifier) WHERE consumedAt IS NULL`
// (`VerificationRepository.upsertLive`), so two concurrent `issue`s for the
// same `identifier` can never both leave a live row behind — the DB
// engine's own conflict resolution replaces the current live row
// atomically instead of racing a separate delete against a separate
// insert; `consume` built on one atomic `UPDATE ... RETURNING`
// (`VerificationRepository.tryConsume`) so unknown/expired/wrong-secret/
// already-consumed all collapse into the same "no row back" result. Both
// give `layerSql` the same win-or-lose-inside-one-atomic-step guarantee
// `layerMemory`'s `Ref.modify`/`HashMap.set` give. BEH-EA-058's transaction
// requirement needs no change to `VerificationShape` at all —
// `SqlClient.withTransaction` already threads transparently, so the
// calling plugin wraps `consume` together with its own state change.
//
// BEH-EA-059: `consume`'s every failure path — expired, unknown, or
// already-consumed — publishes `auth.token.replay` to `AuthEvents.ts`
// before returning `TokenConsumed`, uniformly, since the three cases are
// already indistinguishable to the caller (this module's own `TokenConsumed`
// comment) and so should be indistinguishable to whatever is watching that
// event too.

import { Hmac } from "@awthaq/ports";
import { Models as SqlModels, Repositories as SqlRepositories } from "@awthaq/sql";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as AuthEvents from "./AuthEvents.ts";
import { pruneExpiredAbove } from "./internal/pruneExpired.ts";
import { UserId } from "./Users.ts";

export type VerificationTokenId = string & Brand.Brand<"VerificationTokenId">;
export const VerificationTokenId = Brand.nominal<VerificationTokenId>();

const { toHex } = Hmac;

/**
 * BEH-EA-059/INV-EA-010: every failed consumption — expired, unknown, or
 * already-consumed — is reported through this one error so a caller can
 * publish `auth.token.replay` uniformly, without needing to distinguish
 * "never existed" from "already used" (BEH-EA-064's uniform-response
 * reasoning applies here too: the distinction is exactly what a token-guessing
 * attacker should not be able to observe).
 */
export class TokenConsumed extends Data.TaggedError("TokenConsumed")<{
  readonly message: string;
  readonly identifier: string;
}> {}

export interface VerificationTokenView {
  readonly id: VerificationTokenId;
  /** BEH-EA-057: e.g. `verify-email:<userId>`, `reset-password:<userId>`. */
  readonly identifier: string;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
  /**
   * BEH-EA-122 (`@awthaq/oauth`): an opaque value the issuer attached
   * at `issue` time and gets back verbatim from `consume` — `password`'s
   * reset/verify tokens never needed this (the `userId` they carry round
   * trips inside `identifier` itself), but OAuth flow state
   * (`codeVerifier`/`nonce`/`callbackURL`/`link`) has no such single string
   * to hide inside, and must not leave the server at all. `unknown` here on
   * purpose — this service stores and returns it verbatim, never inspects
   * or validates its shape; the caller who issued it is the only one who
   * knows how to decode it back.
   */
  readonly payload: unknown;
  /** BCR-003: `None` for a token with no real user at issue time (e.g. an OAuth sign-in flow's own state token). */
  readonly userId: Option.Option<UserId>;
}

export interface VerificationShape {
  /** BEH-EA-057/060/061: mints a token scoped to `identifier`, hashed at rest. */
  readonly issue: (input: {
    readonly identifier: string;
    readonly ttl: Duration.Duration;
    readonly payload?: unknown;
    /** BCR-003: attached when the caller already knows the real user this token concerns — lets a later account deletion sweep it. */
    readonly userId?: UserId;
  }) => Effect.Effect<
    { readonly token: VerificationTokenView; readonly value: Redacted.Redacted<string> },
    PlatformError.PlatformError
  >;
  /**
   * BEH-EA-058/062: consumption and the caller's own state change are meant
   * to commit in one transaction — this in-memory Layer's `Ref.modify` is
   * that transaction boundary's stand-in until the SQL Layer (holding the
   * real transaction) replaces it; both are race-safe the same way, at most
   * one concurrent caller ever receives a non-`TokenConsumed` result for the
   * same identifier.
   */
  readonly consume: (
    identifier: string,
    value: Redacted.Redacted<string>,
  ) => Effect.Effect<VerificationTokenView, TokenConsumed | PlatformError.PlatformError>;
  /**
   * BEH-EA-063: `true` only for the first reservation of `identifier` while
   * unexpired, `false` for every later one — independent of `consume`, used
   * to serialize an operation rather than to gate a token a caller presents.
   */
  readonly reserve: (input: {
    readonly identifier: string;
    readonly ttl: Duration.Duration;
  }) => Effect.Effect<boolean>;
  /** BCR-003: sweeps every token (live or already-consumed) naming `userId` — the cascade an account deletion needs. */
  readonly deleteAllByUser: (userId: UserId) => Effect.Effect<void>;
}

export class Verification extends Context.Service<Verification, VerificationShape>()(
  "awthaq/core/Verification",
) {}

interface TokenRow {
  readonly id: VerificationTokenId;
  readonly identifier: string;
  readonly userId: Option.Option<UserId>;
  readonly valueHash: string;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
  readonly payload: unknown;
}

const isExpired = (row: TokenRow, now: DateTime.Utc): boolean =>
  DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.expiresAt);

/**
 * TRBS-005: single-process, test-grade storage. State is one per-process
 * `Ref`: it is not shared across instances (a revocation on one instance does
 * not propagate to another), it is lost on restart, and it grows without bound
 * until a retention sweep (CSG-003) prunes it. Use `layerSql` (or a future KV
 * layer, ADR-EA-014) for any multi-instance deployment. `AuthEvents`' in-process
 * `PubSub` has the same process boundary.
 */
export const layerMemory: Layer.Layer<Verification, never, Crypto.Crypto | AuthEvents.AuthEvents> =
  Layer.effect(
    Verification,
    Effect.gen(function* () {
      const state = yield* Ref.make(HashMap.empty<string, TokenRow>());
      const reservations = yield* Ref.make(HashMap.empty<string, DateTime.Utc>());
      const crypto = yield* Crypto.Crypto;
      const events = yield* AuthEvents.AuthEvents;

      const hash = (value: string) =>
        crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.map(toHex));

      const issue: VerificationShape["issue"] = Effect.fnUntraced(function* (input) {
        const id = VerificationTokenId(yield* crypto.randomUUIDv7);
        const value = toHex(yield* crypto.randomBytes(32));
        const valueHash = yield* hash(value);
        const now = yield* DateTime.now;
        const row: TokenRow = {
          id,
          identifier: input.identifier,
          userId: Option.fromNullishOr(input.userId),
          valueHash,
          createdAt: now,
          expiresAt: DateTime.addDuration(now, input.ttl),
          payload: input.payload,
        };
        // TMS-004: an unconsumed token was never removed; prune expired rows once the map is large.
        yield* Ref.update(state, (s) =>
          HashMap.set(
            pruneExpiredAbove(s, now, (r) => r.expiresAt),
            input.identifier,
            row,
          ),
        );
        return {
          token: {
            id,
            identifier: row.identifier,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            payload: row.payload,
            userId: row.userId,
          },
          value: Redacted.make(value),
        };
      });

      const consume: VerificationShape["consume"] = Effect.fnUntraced(
        function* (identifier, value) {
          const now = yield* DateTime.now;
          const presentedHash = yield* hash(Redacted.value(value));
          // BEH-EA-062: the row is removed by the same atomic step that reads
          // it, so a second concurrent caller sees nothing to consume — win or
          // lose is decided inside `Ref.modify`'s pure function, not by a
          // separate read followed by a separate delete.
          const outcome = yield* Ref.modify(
            state,
            (
              s,
            ): readonly [
              Result.Result<VerificationTokenView, TokenConsumed>,
              HashMap.HashMap<string, TokenRow>,
            ] => {
              const row = HashMap.get(s, identifier);
              if (
                Option.isNone(row) ||
                isExpired(row.value, now) ||
                row.value.valueHash !== presentedHash
              ) {
                return [
                  Result.fail(
                    new TokenConsumed({
                      message: `awthaq: token replay or unknown token: ${identifier}`,
                      identifier,
                    }),
                  ),
                  s,
                ] as const;
              }
              return [
                Result.succeed({
                  id: row.value.id,
                  identifier: row.value.identifier,
                  createdAt: row.value.createdAt,
                  expiresAt: row.value.expiresAt,
                  payload: row.value.payload,
                  userId: row.value.userId,
                }),
                HashMap.remove(s, identifier),
              ] as const;
            },
          );
          // BEH-EA-059: every failed consumption — expired, unknown, or
          // already-consumed — publishes the same `auth.token.replay` event,
          // uniformly, before the caller ever sees `TokenConsumed`.
          return yield* Effect.fromResult(outcome).pipe(
            Effect.tapError(() => events.publish({ _tag: "auth.token.replay", identifier })),
          );
        },
      );

      const reserve: VerificationShape["reserve"] = Effect.fnUntraced(function* (input) {
        const now = yield* DateTime.now;
        return yield* Ref.modify(reservations, (s) => {
          const existing = HashMap.get(s, input.identifier);
          if (
            Option.isSome(existing) &&
            DateTime.toEpochMillis(now) < DateTime.toEpochMillis(existing.value)
          ) {
            return [false, s] as const;
          }
          // TMS-004: expired reservations are otherwise never removed.
          return [
            true,
            HashMap.set(
              pruneExpiredAbove(s, now, (expiresAt) => expiresAt),
              input.identifier,
              DateTime.addDuration(now, input.ttl),
            ),
          ] as const;
        });
      });

      const deleteAllByUser: VerificationShape["deleteAllByUser"] = (userId) =>
        Ref.update(state, (s) =>
          HashMap.filter(s, (row) => !(Option.isSome(row.userId) && row.userId.value === userId)),
        );

      return { issue, consume, reserve, deleteAllByUser };
    }),
  );

const toTokenView = (row: SqlModels.VerificationToken): VerificationTokenView => ({
  id: VerificationTokenId(row.id),
  identifier: row.identifier,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  payload: row.payload === null ? undefined : row.payload,
  userId: Option.fromNullishOr(row.userId).pipe(Option.map((id) => UserId(id))),
});

export const layerSql = Layer.effect(
  Verification,
  Effect.gen(function* () {
    const repo = yield* SqlRepositories.VerificationRepository;
    const reservationsRepo = yield* SqlRepositories.VerificationReservationsRepository;
    const crypto = yield* Crypto.Crypto;
    const events = yield* AuthEvents.AuthEvents;

    const hash = (value: string) =>
      crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.map(toHex));

    const issue: VerificationShape["issue"] = Effect.fnUntraced(function* (input) {
      const value = toHex(yield* crypto.randomBytes(32));
      const valueHash = yield* hash(value);
      const now = yield* DateTime.now;
      const insert = yield* SqlModels.VerificationToken.insert
        .makeEffect({
          identifier: input.identifier,
          userId: input.userId ?? null,
          valueHash,
          expiresAt: DateTime.addDuration(now, input.ttl),
          consumedAt: null,
          payload: input.payload ?? null,
        })
        .pipe(Effect.orDie);
      // BEH-EA-057/ADR-EA-016: one atomic upsert — matches `layerMemory`'s
      // one-live-token overwrite behavior even under two concurrent
      // `issue`s for the same `identifier`, since the DB engine's own
      // conflict resolution (not a separate delete-then-insert racing
      // itself) decides "fresh row" vs. "replace the current live row" in
      // a single statement. Already-consumed history is never touched.
      const row = yield* repo.upsertLive(insert).pipe(Effect.orDie);
      return { token: toTokenView(row), value: Redacted.make(value) };
    });

    const consume: VerificationShape["consume"] = Effect.fnUntraced(function* (identifier, value) {
      const now = yield* DateTime.now;
      const presentedHash = yield* hash(Redacted.value(value));
      // BEH-EA-058/062: one atomic `UPDATE ... RETURNING` decides win or
      // lose — no separate read racing this call's own write, the same
      // guarantee `layerMemory`'s `Ref.modify` gives.
      const claimed = yield* repo
        .tryConsume({ identifier, valueHash: presentedHash, now })
        .pipe(Effect.orDie);
      const outcome: Result.Result<VerificationTokenView, TokenConsumed> = Option.match(claimed, {
        onNone: () =>
          Result.fail(
            new TokenConsumed({
              message: `awthaq: token replay or unknown token: ${identifier}`,
              identifier,
            }),
          ),
        onSome: (row) => Result.succeed(toTokenView(row)),
      });
      // BEH-EA-059: every failed consumption publishes the same
      // `auth.token.replay` event, uniformly, before the caller ever sees
      // `TokenConsumed`.
      return yield* Effect.fromResult(outcome).pipe(
        Effect.tapError(() => events.publish({ _tag: "auth.token.replay", identifier })),
      );
    });

    const reserve: VerificationShape["reserve"] = Effect.fnUntraced(function* (input) {
      const now = yield* DateTime.now;
      return yield* reservationsRepo
        .claim({
          identifier: input.identifier,
          expiresAt: DateTime.addDuration(now, input.ttl),
          now,
        })
        .pipe(Effect.orDie);
    });

    const deleteAllByUser: VerificationShape["deleteAllByUser"] = (userId) =>
      repo.deleteAllByUser(userId).pipe(Effect.orDie);

    return { issue, consume, reserve, deleteAllByUser };
  }),
);
