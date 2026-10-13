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
// requirement is met by `redeem` (ADR-EA-039, which supersedes ADR-EA-016's "no change to
// `VerificationShape`" paragraph): it claims the token and runs the caller's state change in one
// transaction, records a miss itself, and gives the token back when the state change fails, the same
// way over both Layers (SQL by rollback, memory by compensation). `consume` stays as the burn-first
// operation for tokens whose spending is the point (OAuth/SAML request state, the native exchange code).
//
// BEH-EA-059: `consume`'s every failure path — expired, unknown, or
// already-consumed — publishes `auth.token.replay` to `AuthEvents.ts`
// before returning `TokenConsumed`, uniformly, since the three cases are
// already indistinguishable to the caller (this module's own `TokenConsumed`
// comment) and so should be indistinguishable to whatever is watching that
// event too.

import { Defects, Hmac, SqlTransaction } from "@awthaq/ports";
import { Models as SqlModels, Repositories as SqlRepositories } from "@awthaq/sql";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isSqlError } from "effect/unstable/sql/SqlError";
import * as AuthEvents from "./AuthEvents.ts";
import { orStoreUnavailable, storeUnavailable, type StoreUnavailable } from "./Errors.ts";
import { pruneExpiredAbove } from "./internal/pruneExpired.ts";
import { drainBatches } from "./internal/purgeBatches.ts";
import { UserId } from "./Users.ts";

// MA-008: the brand is declared once, in `@awthaq/sql`; this keeps only a nominal constructor.
export type VerificationTokenId = SqlModels.VerificationTokenId;
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
export class TokenConsumed extends Data.TaggedError("Verification/TokenConsumed")<{
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

/**
 * BCR-005: the shape of the value `issue` mints. Absent means today's 256-bit
 * random hex. `Numeric` is a short decimal code a person types (an email OTP);
 * it is drawn inside this module (rejection sampling over `Crypto.randomBytes`,
 * no modulo bias) — a caller never supplies the value itself, so the hashing
 * and single-use guarantees cannot be bypassed with a chosen string.
 */
export type ValueFormat = { readonly _tag: "Numeric"; readonly digits: number };

export type IssueInput = {
  readonly identifier: string;
  readonly ttl: Duration.Duration;
  /** ESS-010: `undefined` and an explicit `null` both mean "no payload". */
  readonly payload?: unknown;
  /** BCR-003: attached when the caller already knows the real user this token concerns — lets a later account deletion sweep it. */
  readonly userId?: UserId;
} & (
  | {
      readonly format?: undefined;
      /**
       * SOS-004: optional for a 256-bit value (unguessable within any TTL), so a wrong
       * presentation never touches the row unless asked to. Each failed `consume` against
       * the live row counts; the row is burned at `maxAttempts` (the right value no longer works).
       */
      readonly maxAttempts?: number;
    }
  | {
      /** BCR-005: a low-entropy value MUST carry an attempt budget — enforced by the type, not by convention. */
      readonly format: ValueFormat;
      readonly maxAttempts: number;
    }
);

/**
 * ADR-EA-039 (BEH-EA-058): how a typed failure of `redeem`'s `use` settles the transaction the token
 * was claimed in. `"rollback"` (the default): nothing `use` wrote stands, and the token is live again.
 * `"commit"`: the token is spent, what `use` wrote stands, and the failure still reaches the caller.
 * This is for a refusal that is itself the outcome the token paid for: a second-factor divert, or a
 * veto after a valid presentation. A defect or an interruption always rolls back.
 */
export type Settlement = "rollback" | "commit";

export interface RedeemInput<A, E, R> {
  readonly identifier: string;
  readonly value: Redacted.Redacted<string>;
  /** The state change the token authorises. Runs inside the transaction that claimed the token. */
  readonly use: (token: VerificationTokenView) => Effect.Effect<A, E, R>;
  readonly onFailure?: ((error: E) => Settlement) | undefined;
}

/** The settlement most callers share: an outage gives the token back, and any refusal spends it. */
export const commitUnlessUnavailable = <E extends { readonly _tag: string }>(error: E) =>
  error._tag === "StoreUnavailable" ? ("rollback" as const) : ("commit" as const);

export interface VerificationShape {
  /** BEH-EA-057/060/061: mints a token scoped to `identifier`, hashed at rest. */
  readonly issue: (
    input: IssueInput,
  ) => Effect.Effect<
    { readonly token: VerificationTokenView; readonly value: Redacted.Redacted<string> },
    StoreUnavailable
  >;
  /**
   * Burn-first: spends the token now, and nothing after it is atomic with the spend. Use it only
   * where spending is the point (an OAuth/SAML request state, a native exchange code). Never call it
   * for a token that authorises a state change: use `redeem`, which owns the transaction. A miss
   * publishes `auth.token.replay` (BEH-EA-059), an attempt event, so it survives the caller's rollback.
   * At most one concurrent caller receives a non-`TokenConsumed` result (BEH-EA-062).
   */
  readonly consume: (
    identifier: string,
    value: Redacted.Redacted<string>,
  ) => Effect.Effect<VerificationTokenView, TokenConsumed | StoreUnavailable>;
  /**
   * BEH-EA-058/059/062, ADR-EA-039: claims the token and runs `use` with it in one transaction.
   * - `use` succeeds: both commit, and the token is spent.
   * - Miss (unknown, expired, already spent, wrong value): `use` never runs. The miss is recorded
   *   (the attempt a budgeted token is owed, `auth.token.replay`, its audit row) and `redeem` fails
   *   with `TokenConsumed`.
   * - `use` fails: `onFailure` settles it (default `"rollback"`: the token is live again, in both
   *   adapters). A defect or an interruption always rolls back.
   * `SqlError` from the transaction itself is `StoreUnavailable("Verification.redeem")`.
   */
  readonly redeem: <A, E, R>(
    input: RedeemInput<A, E, R>,
  ) => Effect.Effect<A, TokenConsumed | E | StoreUnavailable, R>;
  /**
   * BEH-EA-063: `true` only for the first reservation of `identifier` while
   * unexpired, `false` for every later one — independent of `consume`, used
   * to serialize an operation rather than to gate a token a caller presents.
   *
   * MLO-002: the resend-window primitive. `@awthaq/magic-link`'s `MagicLink` and
   * `EmailOtp` reserve `<purpose>-resend:<normalized address>` for the configured
   * window before minting a second mail, so two concurrent requests (or a client
   * hammering "resend") send one message — below, and independent of, the rate limiter.
   */
  readonly reserve: (input: {
    readonly identifier: string;
    readonly ttl: Duration.Duration;
  }) => Effect.Effect<boolean, StoreUnavailable>;
  /** BCR-003: sweeps every token (live or already-consumed) naming `userId` — the cascade an account deletion needs. */
  readonly deleteAllByUser: (userId: UserId) => Effect.Effect<void, StoreUnavailable>;
  /**
   * CSG-003: retention. Physically deletes tokens consumed or expired before
   * `before`, and reservations that expired before it, resolving to how many rows
   * went in all. A live token, and a recently consumed one (`layerSql` keeps the
   * row as replay evidence), stay; `Retention.sweep` calls it with
   * `now - verificationForensicWindow`.
   */
  readonly purgeExpired: (before: DateTime.Utc) => Effect.Effect<number, StoreUnavailable>;
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
  /** SOS-004: `None` = no budget (the default 256-bit token). */
  readonly maxAttempts: Option.Option<number>;
  readonly attempts: number;
}

/** ADR-EA-039: `held` is the rows a `redeem` has claimed and may still give back, keyed by token id. */
interface MemoryTokens {
  readonly live: HashMap.HashMap<string, TokenRow>;
  readonly held: HashMap.HashMap<VerificationTokenId, TokenRow>;
}

const viewOf = (row: TokenRow): VerificationTokenView => ({
  id: row.id,
  identifier: row.identifier,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  payload: row.payload,
  userId: row.userId,
});

const isExpired = (row: TokenRow, now: DateTime.Utc): boolean =>
  DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.expiresAt);

/** BCR-005: bytes at or above this are rejected, so `byte % 10` is uniform (250 = 25 * 10). */
const DIGIT_REJECTION_BOUND = 250;

/** SOS-004: a budget below 1 would burn the token before its first presentation. */
const validBudget = (maxAttempts: number | undefined): Effect.Effect<Option.Option<number>> =>
  maxAttempts === undefined
    ? Effect.succeed(Option.none())
    : Number.isInteger(maxAttempts) && maxAttempts >= 1
      ? Effect.succeed(Option.some(maxAttempts))
      : Defects.invalidConfiguration(
          "Verification.issue.maxAttempts",
          `awthaq: maxAttempts must be a positive integer, got ${maxAttempts}`,
        );

/**
 * BCR-005: mints the value a token is hashed from — 256-bit hex by default, or
 * `digits` uniformly random decimal digits. A digit count outside 4..10 is a
 * caller bug (too short to be worth a budget; too long to type), so it dies.
 */
const mintValue = (
  crypto: Crypto.Crypto,
  format: ValueFormat | undefined,
): Effect.Effect<string, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    if (format === undefined) return toHex(yield* crypto.randomBytes(32));
    if (!Number.isInteger(format.digits) || format.digits < 4 || format.digits > 10) {
      return yield* Defects.invalidConfiguration(
        "Verification.issue.format",
        `awthaq: a numeric value must have 4 to 10 digits, got ${format.digits}`,
      );
    }
    let digits = "";
    while (digits.length < format.digits) {
      const bytes = yield* crypto.randomBytes(format.digits * 2);
      for (const byte of bytes) {
        if (digits.length < format.digits && byte < DIGIT_REJECTION_BOUND)
          digits += String(byte % 10);
      }
    }
    return digits;
  });

/** A `use` failure the transaction must roll back for. Wrapped so it can never be mistaken for an error of the transaction itself. */
interface Rollback<E> {
  readonly _tag: "Verification/Rollback";
  readonly error: E;
}

type Outcome<A, E> =
  | { readonly _tag: "Missed" }
  | { readonly _tag: "Done"; readonly value: A }
  | { readonly _tag: "Refused"; readonly error: E };

/**
 * What each adapter supplies. `consume` and `redeem` are written once over it (plan 02 promotes it
 * to a `VerificationStore` seam).
 */
interface ClaimStore {
  /**
   * One atomic step. Takes the live row for `identifier` whose hash is `valueHash` (SQL: sets
   * `consumedAt`; memory: moves it out of `live`, and into `held` when `hold`). On a miss it spends the
   * attempt a budgeted live row is owed (SOS-004): memory in the same step, SQL in the unit of work's
   * `afterUnit` lane (ADR-EA-037) so a rolled-back caller still burns the budget. `None` is a miss.
   */
  readonly claim: (input: {
    readonly identifier: string;
    readonly valueHash: string;
    readonly now: DateTime.Utc;
    readonly hold: boolean;
    readonly operation: string;
  }) => Effect.Effect<Option.Option<VerificationTokenView>, StoreUnavailable>;
  /** The unit `redeem` runs in. `layerSql`: one transaction (a savepoint inside an outer one). `layerMemory`: the effect itself. */
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StoreUnavailable, R>;
  /**
   * After a held claim's `use` ended. `"kept"` drops the hold. `"returned"` gives the row back, unless a
   * newer `issue` replaced it or `deleteAllByUser` swept it meanwhile. Over SQL this is a no-op, because
   * the rollback already did it.
   */
  readonly release: (id: VerificationTokenId, how: "kept" | "returned") => Effect.Effect<void>;
}

const makeTokenFlows = (
  store: ClaimStore,
  crypto: Crypto.Crypto,
  events: AuthEvents.AuthEventsShape,
) => {
  const hashOf = (value: Redacted.Redacted<string>, operation: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(Redacted.value(value)))
      .pipe(Effect.map(toHex), Effect.catchTag("PlatformError", storeUnavailable(operation)));

  const missed = (identifier: string) =>
    new TokenConsumed({ message: "awthaq: token replay or unknown token", identifier });

  /** BEH-EA-059: a miss is published once, here, whichever operation saw it (an attempt event, ADR-EA-037). */
  const claimOrMiss = Effect.fnUntraced(function* (
    identifier: string,
    value: Redacted.Redacted<string>,
    hold: boolean,
    operation: string,
  ) {
    const valueHash = yield* hashOf(value, operation);
    const now = yield* DateTime.now;
    const token = yield* store.claim({ identifier, valueHash, now, hold, operation });
    if (Option.isNone(token)) yield* events.publish({ _tag: "auth.token.replay", identifier });
    return token;
  });

  const consume: VerificationShape["consume"] = (identifier, value) =>
    claimOrMiss(identifier, value, false, "Verification.consume").pipe(
      Effect.flatMap(
        Option.match({ onNone: () => Effect.fail(missed(identifier)), onSome: Effect.succeed }),
      ),
    );

  const redeem = <A, E, R>(input: RedeemInput<A, E, R>) =>
    store
      .transaction(
        Effect.gen(function* () {
          const token = yield* claimOrMiss(
            input.identifier,
            input.value,
            true,
            "Verification.redeem",
          );
          // A miss is an outcome, not a failure: this transaction commits (it wrote nothing), and the
          // spent attempt and the replay event already went through the unit's `afterUnit` lane.
          if (Option.isNone(token)) return yield* Effect.succeed<Outcome<A, E>>({ _tag: "Missed" });
          return yield* input.use(token.value).pipe(
            Effect.map((value): Outcome<A, E> => ({ _tag: "Done", value })),
            Effect.catch(
              Effect.fnUntraced(function* (error: E) {
                if (input.onFailure?.(error) === "commit")
                  return { _tag: "Refused", error } as const;
                return yield* Effect.fail<Rollback<E>>({ _tag: "Verification/Rollback", error });
              }),
            ),
            // Success here means the transaction commits (a result, or a refusal settled as commit).
            // Any failure (a rollback-settled error, a defect, an interruption) means it rolls back.
            Effect.onExit((exit) =>
              store.release(token.value.id, Exit.isSuccess(exit) ? "kept" : "returned"),
            ),
          );
        }),
      )
      .pipe(
        Effect.catchTag("Verification/Rollback", (rollback) => Effect.fail(rollback.error)),
        Effect.flatMap(
          Effect.fnUntraced(function* (outcome: Outcome<A, E>) {
            if (outcome._tag === "Done") return outcome.value;
            if (outcome._tag === "Refused") return yield* Effect.fail(outcome.error);
            return yield* Effect.fail(missed(input.identifier));
          }),
        ),
      );

  return { consume, redeem };
};

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
      const tokens = yield* Ref.make<MemoryTokens>({
        live: HashMap.empty(),
        held: HashMap.empty(),
      });
      const reservations = yield* Ref.make(HashMap.empty<string, DateTime.Utc>());
      const crypto = yield* Crypto.Crypto;
      const events = yield* AuthEvents.AuthEvents;

      const hash = (value: string) =>
        crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.map(toHex));

      const issue: VerificationShape["issue"] = Effect.fnUntraced(
        function* (input) {
          const id = VerificationTokenId(yield* crypto.randomUUIDv7);
          const maxAttempts = yield* validBudget(input.maxAttempts);
          const value = yield* mintValue(crypto, input.format);
          const valueHash = yield* hash(value);
          const now = yield* DateTime.now;
          const row: TokenRow = {
            id,
            identifier: input.identifier,
            userId: Option.fromNullishOr(input.userId),
            valueHash,
            maxAttempts,
            attempts: 0,
            createdAt: now,
            expiresAt: DateTime.addDuration(now, input.ttl),
            // ESS-010: an explicit `null` is treated as absent, exactly as
            // `layerSql` stores it (a JSON `null` column decodes to `undefined`),
            // so both layers hand back the same `payload`.
            payload: input.payload === null ? undefined : input.payload,
          };
          // TMS-004: an unconsumed token was never removed; prune expired rows once the map is large.
          yield* Ref.update(tokens, (s) => ({
            ...s,
            live: HashMap.set(
              pruneExpiredAbove(s.live, now, (r) => r.expiresAt),
              input.identifier,
              row,
            ),
          }));
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
        },
        Effect.catchTag("PlatformError", storeUnavailable("Verification.issue")),
      );

      const store = {
        claim: ({ identifier, valueHash, now, hold }) =>
          // BEH-EA-062: the row is removed by the same atomic step that reads it, so a second
          // concurrent caller sees nothing to claim: win or lose is decided inside `Ref.modify`'s
          // pure function, not by a separate read followed by a separate delete.
          Ref.modify(tokens, (s) => {
            const row = HashMap.get(s.live, identifier);
            if (Option.isNone(row) || isExpired(row.value, now)) return [Option.none(), s] as const;
            // ACS-002: the digest is compared in constant time, like `Sessions`' secret hash;
            // `layerSql` does it in the DB predicate.
            if (!Hmac.constantTimeEqualString(row.value.valueHash, valueHash)) {
              // SOS-004: a wrong presentation against a live budgeted row spends one attempt, and
              // the row is burned when the budget is gone, in the same atomic step, so concurrent
              // guesses cannot exceed it.
              const spent = row.value.attempts + 1;
              const burned =
                Option.isSome(row.value.maxAttempts) && spent >= row.value.maxAttempts.value;
              const live = Option.isNone(row.value.maxAttempts)
                ? s.live
                : burned
                  ? HashMap.remove(s.live, identifier)
                  : HashMap.set(s.live, identifier, { ...row.value, attempts: spent });
              return [Option.none(), { ...s, live }] as const;
            }
            return [
              Option.some(viewOf(row.value)),
              {
                live: HashMap.remove(s.live, identifier),
                held: hold ? HashMap.set(s.held, row.value.id, row.value) : s.held,
              },
            ] as const;
          }),
        transaction: (effect) => effect,
        release: (id, how) =>
          Ref.update(tokens, (s) => {
            const row = HashMap.get(s.held, id);
            if (Option.isNone(row)) return s; // swept by deleteAllByUser while `use` ran
            const held = HashMap.remove(s.held, id);
            // A fresh `issue` for the identifier superseded this row while `use` ran: the newer row wins.
            return how === "kept" || HashMap.has(s.live, row.value.identifier)
              ? { ...s, held }
              : { live: HashMap.set(s.live, row.value.identifier, row.value), held };
          }),
      } satisfies ClaimStore;

      const { consume, redeem } = makeTokenFlows(store, crypto, events);

      const reserve: VerificationShape["reserve"] = Effect.fnUntraced(function* (input) {
        const now = yield* DateTime.now;
        return yield* Ref.modify(reservations, (s) => {
          const existing = HashMap.get(s, input.identifier);
          if (
            Option.isSome(existing) &&
            DateTime.toEpochMillis(now) < DateTime.toEpochMillis(existing.value)
          ) {
            // BEH-EA-063: expired iff `now >= expiresAt`; a live reservation refuses.
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
        Ref.update(tokens, (s) => {
          const keep = (row: TokenRow) =>
            !(Option.isSome(row.userId) && row.userId.value === userId);
          // A held claim is swept too, so a rollback cannot resurrect an erased user's token (plan 03).
          return { live: HashMap.filter(s.live, keep), held: HashMap.filter(s.held, keep) };
        });

      const purgeExpired: VerificationShape["purgeExpired"] = (before) =>
        Effect.gen(function* () {
          const cutoff = DateTime.toEpochMillis(before);
          // Never an in-flight hold: `held` is not pruned.
          const expiredTokens = yield* Ref.modify(tokens, (s) => {
            const kept = HashMap.filter(
              s.live,
              (row) => DateTime.toEpochMillis(row.expiresAt) >= cutoff,
            );
            return [HashMap.size(s.live) - HashMap.size(kept), { ...s, live: kept }] as const;
          });
          const reserved = yield* Ref.modify(reservations, (s) => {
            const kept = HashMap.filter(
              s,
              (expiresAt) => DateTime.toEpochMillis(expiresAt) >= cutoff,
            );
            return [HashMap.size(s) - HashMap.size(kept), kept] as const;
          });
          return expiredTokens + reserved;
        });

      return { issue, consume, redeem, reserve, deleteAllByUser, purgeExpired };
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
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const events = yield* AuthEvents.AuthEvents;

    const hash = (value: string) =>
      crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.map(toHex));

    const issue: VerificationShape["issue"] = Effect.fnUntraced(
      function* (input) {
        const maxAttempts = yield* validBudget(input.maxAttempts);
        const value = yield* mintValue(crypto, input.format);
        const valueHash = yield* hash(value);
        const now = yield* DateTime.now;
        const insert = yield* repo.models.VerificationToken.insert
          .makeEffect({
            identifier: input.identifier,
            userId: input.userId ?? null,
            valueHash,
            maxAttempts: Option.getOrNull(maxAttempts),
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
        // a single statement. Already-consumed history is never touched by `issue`
        // (only `purgeExpired`, past the forensic window, removes it).
        const row = yield* repo.upsertLive(insert);
        return { token: toTokenView(row), value: Redacted.make(value) };
      },
      Effect.catchTags({
        PlatformError: storeUnavailable("Verification.issue"),
        SqlError: storeUnavailable("Verification.issue"),
        SchemaError: Effect.die,
        NoSuchElementError: Effect.die,
      }),
    );

    const store = {
      claim: ({ identifier, valueHash, now, operation }) =>
        Effect.gen(function* () {
          // SOS-004: read the live row first, so a miss is charged to the row it was judged against
          // (`recordFailedAttempt` is pinned to that row's id). A reissue replaces the live row and its
          // id: one landing between this read and the spend finds nothing to charge, instead of
          // spending an attempt of a token the wrong presentation never saw.
          const judged = yield* repo.findByIdentifier(identifier);
          // BEH-EA-058/062: one atomic `UPDATE ... RETURNING` decides win or lose: no separate read
          // racing this call's own write, the same guarantee `layerMemory`'s `Ref.modify` gives.
          const claimed = yield* repo.tryConsume({ identifier, valueHash, now });
          // SOS-004: a miss against a live budgeted row spends one attempt (one atomic statement; a
          // row with no budget, an unknown or an expired one is untouched). A caller inside its own
          // transaction fails it with the miss, which would roll the spend back too: so the spend runs
          // in the unit of work's `afterUnit` lane, outside the transaction, committed or not
          // (ADR-EA-037). Outside any unit it runs right here. It is best effort there: the miss must
          // still answer uniformly (BEH-EA-116), so a store failure is logged and counted, never
          // turned into a different response.
          if (Option.isNone(claimed) && Option.isSome(judged)) {
            yield* SqlTransaction.afterUnit(
              repo
                .recordFailedAttempt({ id: judged.value.id, now })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError(
                      "awthaq: the failed attempt against a verification token could not be recorded",
                      cause,
                    ),
                  ),
                ),
            );
          }
          return Option.map(claimed, toTokenView);
        }).pipe(
          Effect.catchTags({
            SqlError: storeUnavailable(operation),
            SchemaError: Effect.die,
          }),
        ),
      // ADR-EA-039: one real transaction (a savepoint inside an outer one, such as the RLS tenant
      // transaction). `catchIf(isSqlError)` rather than `catchTag`, because the body's own error
      // type is generic: only a real `SqlError` (BEGIN/COMMIT) becomes the typed outage.
      transaction: (effect) =>
        SqlTransaction.transactional(sql)(effect).pipe(
          Effect.catchIf(isSqlError, storeUnavailable("Verification.redeem")),
        ),
      release: () => Effect.void,
    } satisfies ClaimStore;

    const { consume, redeem } = makeTokenFlows(store, crypto, events);

    const reserve: VerificationShape["reserve"] = Effect.fnUntraced(
      function* (input) {
        const now = yield* DateTime.now;
        return yield* reservationsRepo.claim({
          identifier: input.identifier,
          expiresAt: DateTime.addDuration(now, input.ttl),
          now,
        });
      },
      Effect.catchTags({
        SqlError: storeUnavailable("Verification.reserve"),
        SchemaError: Effect.die,
      }),
    );

    const deleteAllByUser: VerificationShape["deleteAllByUser"] = (userId) =>
      repo
        .deleteAllByUser(userId)
        .pipe(Effect.catchTag("SqlError", storeUnavailable("Verification.deleteAllByUser")));

    // CSG-003: consumed rows are kept as replay evidence (BEH-EA-058) until the retention
    // sweep's forensic window passes; a bounded loop of short deletes, tokens then reservations.
    const purgeExpired: VerificationShape["purgeExpired"] = (before) =>
      Effect.all([
        drainBatches((limit) =>
          repo
            .deleteExpiredBefore(before, limit)
            .pipe(orStoreUnavailable("Verification.purgeExpired")),
        ),
        drainBatches((limit) =>
          reservationsRepo
            .deleteExpiredBefore(before, limit)
            .pipe(orStoreUnavailable("Verification.purgeExpired")),
        ),
      ]).pipe(Effect.map(([tokens, reserved]) => tokens + reserved));

    return { issue, consume, redeem, reserve, deleteAllByUser, purgeExpired };
  }),
);
