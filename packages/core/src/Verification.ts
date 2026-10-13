// @awthaq/core — Verification
//
// spec/behaviors/08-verification-tokens.md, BEH-EA-057 through BEH-EA-064.
// Plan 02 (ADR-EA-041): written once, over `@awthaq/ports`' `VerificationStore` (a `Ref` adapter
// there, a SQL adapter in `@awthaq/sql`). Per `spec/decisions/016-verification-sql-claiming.md`
// (ADR-EA-016) the store's primitives are the atomic steps: `upsertLive` replaces the identifier's
// one unconsumed row in a single step (the SQL adapter's is one `INSERT ... ON CONFLICT ... DO
// UPDATE` against a partial unique index), `present` claims a token in a single step (unknown,
// expired, wrong-secret and already-consumed all collapse into the same miss), and `reserve` is a
// conditional upsert into a dedicated reservations table. BEH-EA-058's transaction requirement is
// met by `redeem` (ADR-EA-039, which supersedes ADR-EA-016's "no change to `VerificationShape`"
// paragraph): it claims the token and runs the caller's state change in one transaction, records a
// miss itself, and gives the token back when the state change fails (the SQL adapter by rollback,
// the `Ref` adapter by `settle`'s compensation). `consume` stays as the burn-first operation for
// tokens whose spending is the point (OAuth/SAML request state, the native exchange code).
//
// BEH-EA-059: `consume`'s every failure path — expired, unknown, or
// already-consumed — publishes `auth.token.replay` to `AuthEvents.ts`
// before returning `TokenConsumed`, uniformly, since the three cases are
// already indistinguishable to the caller (this module's own `TokenConsumed`
// comment) and so should be indistinguishable to whatever is watching that
// event too.

import { Defects, Hmac, type Ids, VerificationStore } from "@awthaq/ports";
import { VerificationStoreSql, type Repositories as SqlRepositories } from "@awthaq/sql";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as AuthEvents from "./AuthEvents.ts";
import { relabel, storeUnavailable, type StoreUnavailable } from "./Errors.ts";
import { UserId } from "./Users.ts";

// MA-008: the brand is declared once, in `@awthaq/ports` (`Ids`); this keeps only a nominal constructor.
export type VerificationTokenId = Ids.VerificationTokenId;
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

/** The payload as a caller sees it: parsed from the stored JSON text, `undefined` when there is none (ESS-010). */
const decodePayload = (json: Option.Option<string>): unknown =>
  Option.match(json, {
    onNone: () => undefined,
    onSome: (text): unknown => JSON.parse(text),
  });

const viewOf = (row: VerificationStore.TokenRow): VerificationTokenView => ({
  id: row.id,
  identifier: row.identifier,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  payload: decodePayload(row.payloadJson),
  userId: row.userId,
});

/**
 * BEH-EA-122: the payload is stored as JSON text, encoded here once for every adapter. `undefined`
 * and an explicit `null` both mean "no payload" (ESS-010); anything JSON cannot carry (a `bigint`, a
 * cycle, a function) is a caller bug, so a defect on every backend instead of a silent change.
 */
const encodePayload = (payload: unknown): Effect.Effect<Option.Option<string>> =>
  payload === undefined || payload === null
    ? Effect.succeed(Option.none())
    : Effect.try({
        try: () => {
          const text: unknown = JSON.stringify(payload);
          if (typeof text !== "string") throw new TypeError("not representable as JSON");
          return Option.some(text);
        },
        catch: (cause) =>
          new Defects.InvalidConfiguration({
            setting: "Verification.issue.payload",
            message: `awthaq: a token payload must be JSON-encodable: ${String(cause)}`,
          }),
      }).pipe(Effect.orDie);

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
 * What `consume` and `redeem` need of a store, in the domain's own terms: `VerificationStore`'s
 * primitives with the views and the operation labels applied (see the layer below).
 */
interface ClaimStore {
  /**
   * One atomic step (`VerificationStore.present`). Takes the live row for `identifier` whose hash is
   * `valueHash`, and holds it aside when `hold`. On a miss it spends the attempt a budgeted live row
   * is owed (SOS-004), in a way that survives a rolled-back caller (ADR-EA-037). `None` is a miss.
   */
  readonly claim: (input: {
    readonly identifier: string;
    readonly valueHash: string;
    readonly now: DateTime.Utc;
    readonly hold: boolean;
    readonly operation: string;
  }) => Effect.Effect<Option.Option<VerificationTokenView>, StoreUnavailable>;
  /** The unit `redeem` runs in (`VerificationStore.transaction`). */
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StoreUnavailable, R>;
  /**
   * After a held claim's `use` ended (`VerificationStore.settle`). `"kept"` drops the hold.
   * `"returned"` gives the row back, unless a newer `issue` replaced it or `deleteAllByUser` swept it
   * meanwhile. Over SQL this is a no-op, because the rollback already did it.
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
 * Written once over `VerificationStore` (ADR-EA-041). Needs the store, `Crypto` (the value and its
 * hash) and `AuthEvents` (the replay event).
 */
export const layer = Layer.effect(
  Verification,
  Effect.gen(function* () {
    const store = yield* VerificationStore.VerificationStore;
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
        const payloadJson = yield* encodePayload(input.payload);
        // BEH-EA-057/ADR-EA-016: one atomic upsert replaces the identifier's one live token, so two
        // concurrent `issue`s never leave two. Already-consumed history is never touched by `issue`
        // (only `purgeExpired`, past the forensic window, removes it).
        const row = yield* store.upsertLive({
          id,
          identifier: input.identifier,
          userId: Option.fromNullishOr(input.userId),
          valueHash,
          createdAt: now,
          expiresAt: DateTime.addDuration(now, input.ttl),
          payloadJson,
          maxAttempts,
        });
        return { token: viewOf(row), value: Redacted.make(value) };
      },
      Effect.catchTag("PlatformError", storeUnavailable("Verification.issue")),
      relabel("Verification.issue"),
    );

    const claimStore: ClaimStore = {
      claim: ({ identifier, valueHash, now, hold, operation }) =>
        store.present({ identifier, valueHash, now, hold }).pipe(
          Effect.map((outcome) =>
            outcome._tag === "Hit" ? Option.some(viewOf(outcome.row)) : Option.none(),
          ),
          relabel(operation),
        ),
      transaction: (effect) => store.transaction(effect).pipe(relabel("Verification.redeem")),
      release: (id, how) =>
        store.settle(id, how).pipe(
          // A give-back that cannot be recorded must not mask the outcome of the caller's own work.
          Effect.catchTag("StoreUnavailable", (error) =>
            Effect.logWarning("awthaq: a held verification token could not be settled", error),
          ),
        ),
    };

    const { consume, redeem } = makeTokenFlows(claimStore, crypto, events);

    const reserve: VerificationShape["reserve"] = Effect.fnUntraced(function* (input) {
      const now = yield* DateTime.now;
      return yield* store.reserve({
        identifier: input.identifier,
        expiresAt: DateTime.addDuration(now, input.ttl),
        now,
      });
    }, relabel("Verification.reserve"));

    const deleteAllByUser: VerificationShape["deleteAllByUser"] = (userId) =>
      store.deleteByUser(userId).pipe(Effect.asVoid, relabel("Verification.deleteAllByUser"));

    const purgeExpired: VerificationShape["purgeExpired"] = (before) =>
      store.purgeExpired(before).pipe(relabel("Verification.purgeExpired"));

    return { issue, consume, redeem, reserve, deleteAllByUser, purgeExpired };
  }),
);

// ---- transitional aliases (removed in phase 7) -----------------------------------

/**
 * TRBS-005: single-process, test-grade storage. It is not shared across instances (a revocation on
 * one instance does not propagate to another), it is lost on restart, and it grows until a
 * retention sweep (CSG-003) prunes it. Use `layerSql` (or a future KV store, ADR-EA-014) for any
 * multi-instance deployment.
 */
export const layerMemory = layer.pipe(Layer.provide(VerificationStore.layerMemory));

// The annotation is the TS2883 exception (declaration emit cannot name the repositories through the
// adapter's inferred layer type); this alias is removed with `layerMemory` in phase 7.
export const layerSql: Layer.Layer<
  Verification,
  never,
  | SqlRepositories.VerificationRepository
  | SqlRepositories.VerificationReservationsRepository
  | SqlClient.SqlClient
  | Crypto.Crypto
  | AuthEvents.AuthEvents
> = layer.pipe(Layer.provide(VerificationStoreSql.layer));
