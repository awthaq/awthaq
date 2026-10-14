// @awthaq/ports — VerificationStore
//
// Plan 02 (ADR-EA-041): the store port under `Verification`. `Verification` (core) owns every
// domain rule of verification tokens and reservations: minting and hashing the value, the attempt
// budget's validation, the payload codec, the uniform `TokenConsumed` answer, `auth.token.replay`,
// and the `redeem` protocol (ADR-EA-039). This port owns only persistence, and every primitive is
// atomic by contract, on every adapter (`StoreContract.verification`).
//
// A token row is identified by its purpose-scoped `identifier` while it is live (at most one
// unconsumed row per identifier, ADR-EA-016); consumed rows are kept as replay evidence until a
// retention sweep (`purgeExpired`) passes them (BEH-EA-061). The payload is the caller's JSON text;
// the domain encodes and decodes it, the store keeps it opaque.
//
// The `Ref` adapter here is single-process and test-grade (TRBS-005). Production composes the SQL
// adapter (`@awthaq/sql` `VerificationStoreSql`) through `Persistence.sql()`.

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Hmac from "./Hmac.ts";
import type { UserId, VerificationTokenId } from "./Ids.ts";
import * as PruneExpired from "./PruneExpired.ts";
import type { StoreUnavailable } from "./Store.ts";
import * as Tenant from "./Tenant.ts";

/** One verification token as the store keeps it: only the hash of the value, never the value. */
export interface TokenRow {
  readonly id: VerificationTokenId;
  /** Purpose-scoped (`verify-email:<userId>`, `reset-password:<userId>`, ...). */
  readonly identifier: string;
  readonly userId: Option.Option<UserId>;
  readonly valueHash: string;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
  /** The caller's payload as JSON text; opaque to the store. */
  readonly payloadJson: Option.Option<string>;
  /** SOS-004: `None` = no attempt budget (the default 256-bit token). */
  readonly maxAttempts: Option.Option<number>;
  readonly attempts: number;
  /** `Some` once the token was spent or burned; the row is kept as evidence. */
  readonly consumedAt: Option.Option<DateTime.Utc>;
  /** Stamped by the adapter from the ambient tenant (BEH-EA-231). */
  readonly tenantId: Option.Option<string>;
}

/** What `upsertLive` writes; the store adds the attempt count, the consumed mark and the tenant. */
export type NewToken = Omit<TokenRow, "consumedAt" | "attempts" | "tenantId">;

export type PresentOutcome =
  | { readonly _tag: "Hit"; readonly row: TokenRow }
  | { readonly _tag: "Miss" };

export interface VerificationStoreShape {
  /**
   * ATOMIC: replaces the identifier's UNCONSUMED row, or inserts one (ADR-EA-016: two concurrent
   * upserts for one identifier leave exactly one live row). Already-consumed history is never
   * touched. Stamps the ambient tenant. Idempotent on `row.id`.
   */
  readonly upsertLive: (row: NewToken) => Effect.Effect<TokenRow, StoreUnavailable>;
  /**
   * ONE atomic step (BEH-EA-058/062): the live, unexpired (`expiresAt > now`) row of `identifier`
   * whose `valueHash` equals the presented one is marked consumed at `now` and returned as `Hit`;
   * of any number of concurrent presentations exactly one is a `Hit`. Anything else is a `Miss`
   * (unknown, expired, spent, wrong value), and a `Miss` against a live row with an attempt budget
   * spends one attempt, burning the row (consumed) when the budget is gone (SOS-004). The spend is
   * charged to the row the miss was judged against, and MUST survive the rollback of a caller's
   * transaction: the SQL adapter runs it in the unit of work's `afterUnit` lane (ADR-EA-037).
   * Comparison: the `Ref` adapter compares the hashes in constant time (ACS-002).
   *
   * `hold`: the claimed row is kept aside so a caller that fails afterwards can give it back
   * (`settle`). Set it only inside `transaction`.
   *
   * NOT retried by an adapter on a transient failure: a presentation that succeeded but was not
   * acknowledged would come back as a `Miss`.
   */
  readonly present: (input: {
    readonly identifier: string;
    readonly valueHash: string;
    readonly now: DateTime.Utc;
    readonly hold: boolean;
  }) => Effect.Effect<PresentOutcome, StoreUnavailable>;
  /**
   * After a held `present`'s caller finished (ADR-EA-039). `"kept"` drops the hold: the token stays
   * spent. `"returned"` gives the row back (live again, attempts as they were), unless a newer
   * `upsertLive` replaced it or `deleteByUser` swept it meanwhile. A store whose caller's
   * transaction already rolled the claim back (SQL) has nothing to do: both are no-ops there.
   */
  readonly settle: (
    id: VerificationTokenId,
    how: "kept" | "returned",
  ) => Effect.Effect<void, StoreUnavailable>;
  /**
   * The unit `redeem` runs the claim and the caller's state change in. SQL: one real transaction
   * (a savepoint inside an enclosing one); a `Ref` adapter: the effect itself (its writes cannot be
   * rolled back, which is what `settle` compensates for). A failure of the transaction itself
   * (BEGIN/COMMIT) is `StoreUnavailable`; the body's own errors pass through untouched.
   */
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StoreUnavailable, R>;
  /**
   * ATOMIC (BEH-EA-063): `true` only for the first reservation of `identifier` while unexpired.
   * An existing reservation is expired iff `existing.expiresAt <= now`, so a reservation made with
   * a zero ttl is free at once and one made with a positive ttl is free at exactly `expiresAt`.
   * Stamps the ambient tenant. NOT retried (a granted reservation whose answer was lost would
   * read as taken).
   */
  readonly reserve: (input: {
    readonly identifier: string;
    readonly expiresAt: DateTime.Utc;
    readonly now: DateTime.Utc;
  }) => Effect.Effect<boolean, StoreUnavailable>;
  /** BCR-003: sweeps every token naming `userId`, live or consumed. Resolves to how many went. Reservations are not swept. */
  readonly deleteByUser: (userId: UserId) => Effect.Effect<number, StoreUnavailable>;
  /**
   * CSG-003: retention. Deletes tokens consumed or expired before `before` and reservations that
   * expired before it; a live token and a recently consumed one stay. Adapters may batch. Resolves
   * to how many rows went in all.
   */
  readonly purgeExpired: (before: DateTime.Utc) => Effect.Effect<number, StoreUnavailable>;
}

export class VerificationStore extends Context.Service<VerificationStore, VerificationStoreShape>()(
  "awthaq/ports/VerificationStore",
) {}

// ---- the Ref adapter ------------------------------------------------------------------------

interface Reservation {
  readonly expiresAt: DateTime.Utc;
  readonly tenantId: Option.Option<string>;
}

/**
 * `live`: the unconsumed row per identifier. `held`: rows a `redeem` claimed and may still give back,
 * by token id. `history`: consumed rows, kept as evidence until `purgeExpired` passes them.
 */
interface State {
  readonly live: HashMap.HashMap<string, TokenRow>;
  readonly held: HashMap.HashMap<VerificationTokenId, TokenRow>;
  readonly history: ReadonlyArray<TokenRow>;
  readonly reservations: HashMap.HashMap<string, Reservation>;
}

const isExpired = (row: TokenRow, now: DateTime.Utc): boolean =>
  DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.expiresAt);

const miss: PresentOutcome = { _tag: "Miss" };

/**
 * Single-process, test-grade (TRBS-005): state is lost on restart and is not shared across
 * instances. Each primitive is one `Ref.modify`, so win-or-lose is decided inside a pure function.
 */
export const layerMemory = Layer.effect(
  VerificationStore,
  Effect.gen(function* () {
    const state = yield* Ref.make<State>({
      live: HashMap.empty(),
      held: HashMap.empty(),
      history: [],
      reservations: HashMap.empty(),
    });

    const upsertLive: VerificationStoreShape["upsertLive"] = (row) =>
      Effect.flatMap(Tenant.resolve(Option.none()), (tenantId) => {
        const stored: TokenRow = {
          ...row,
          attempts: 0,
          consumedAt: Option.none(),
          tenantId,
        };
        return Ref.modify(state, (s) => [
          stored,
          {
            ...s,
            // TMS-004: an unconsumed token was never removed; prune expired rows once the map is large.
            live: HashMap.set(
              PruneExpired.pruneExpiredAbove(s.live, row.createdAt, (r) => r.expiresAt),
              row.identifier,
              stored,
            ),
          },
        ]);
      });

    const present: VerificationStoreShape["present"] = ({ identifier, valueHash, now, hold }) =>
      Ref.modify<State, PresentOutcome>(state, (s) => {
        const row = HashMap.get(s.live, identifier);
        if (Option.isNone(row) || isExpired(row.value, now)) return [miss, s];
        // ACS-002: the digest is compared in constant time, like `Sessions`' secret hash.
        if (!Hmac.constantTimeEqualString(row.value.valueHash, valueHash)) {
          // SOS-004: a wrong presentation against a live budgeted row spends one attempt, and the
          // row is burned when the budget is gone, in the same atomic step, so concurrent guesses
          // cannot exceed it.
          if (Option.isNone(row.value.maxAttempts)) return [miss, s];
          const attempts = row.value.attempts + 1;
          if (attempts < row.value.maxAttempts.value) {
            return [
              miss,
              { ...s, live: HashMap.set(s.live, identifier, { ...row.value, attempts }) },
            ];
          }
          const burned: TokenRow = { ...row.value, attempts, consumedAt: Option.some(now) };
          return [
            miss,
            {
              ...s,
              live: HashMap.remove(s.live, identifier),
              history: [...s.history, burned],
            },
          ];
        }
        const consumed: TokenRow = { ...row.value, consumedAt: Option.some(now) };
        return [
          { _tag: "Hit", row: consumed },
          {
            ...s,
            live: HashMap.remove(s.live, identifier),
            held: hold ? HashMap.set(s.held, row.value.id, row.value) : s.held,
            history: [...s.history, consumed],
          },
        ];
      });

    const settle: VerificationStoreShape["settle"] = (id, how) =>
      Ref.update(state, (s) => {
        const row = HashMap.get(s.held, id);
        if (Option.isNone(row)) return s; // swept by deleteByUser while the caller ran
        const held = HashMap.remove(s.held, id);
        // A newer `upsertLive` for the identifier replaced this row meanwhile: the newer row wins.
        if (how === "kept" || HashMap.has(s.live, row.value.identifier)) return { ...s, held };
        return {
          ...s,
          held,
          live: HashMap.set(s.live, row.value.identifier, row.value),
          history: s.history.filter((consumed) => consumed.id !== id),
        };
      });

    const reserve: VerificationStoreShape["reserve"] = ({ identifier, expiresAt, now }) =>
      Effect.flatMap(Tenant.resolve(Option.none()), (tenantId) =>
        Ref.modify(state, (s) => {
          const existing = HashMap.get(s.reservations, identifier);
          // BEH-EA-063: expired iff `now >= expiresAt`, so a live reservation refuses.
          if (
            Option.isSome(existing) &&
            DateTime.toEpochMillis(now) < DateTime.toEpochMillis(existing.value.expiresAt)
          ) {
            return [false, s];
          }
          return [
            true,
            {
              ...s,
              // TMS-004: expired reservations are otherwise never removed.
              reservations: HashMap.set(
                PruneExpired.pruneExpiredAbove(s.reservations, now, (r) => r.expiresAt),
                identifier,
                { expiresAt, tenantId },
              ),
            },
          ];
        }),
      );

    const deleteByUser: VerificationStoreShape["deleteByUser"] = (userId) =>
      Ref.modify(state, (s) => {
        const keep = (row: TokenRow) => !(Option.isSome(row.userId) && row.userId.value === userId);
        const live = HashMap.filter(s.live, keep);
        const history = s.history.filter(keep);
        const removed =
          HashMap.size(s.live) - HashMap.size(live) + (s.history.length - history.length);
        // A held claim is swept too, so a give-back cannot resurrect an erased user's token.
        return [removed, { ...s, live, history, held: HashMap.filter(s.held, keep) }];
      });

    const purgeExpired: VerificationStoreShape["purgeExpired"] = (before) =>
      Ref.modify(state, (s) => {
        const cutoff = DateTime.toEpochMillis(before);
        // Never an in-flight hold: `held` is not pruned.
        const live = HashMap.filter(
          s.live,
          (row) => DateTime.toEpochMillis(row.expiresAt) >= cutoff,
        );
        const history = s.history.filter(
          (row) =>
            !(
              (Option.isSome(row.consumedAt) &&
                DateTime.toEpochMillis(row.consumedAt.value) < cutoff) ||
              DateTime.toEpochMillis(row.expiresAt) < cutoff
            ),
        );
        const reservations = HashMap.filter(
          s.reservations,
          (reservation) => DateTime.toEpochMillis(reservation.expiresAt) >= cutoff,
        );
        const removed =
          HashMap.size(s.live) -
          HashMap.size(live) +
          (s.history.length - history.length) +
          (HashMap.size(s.reservations) - HashMap.size(reservations));
        return [removed, { ...s, live, history, reservations }];
      });

    return VerificationStore.of({
      upsertLive,
      present,
      settle,
      transaction: (effect) => effect,
      reserve,
      deleteByUser,
      purgeExpired,
    });
  }),
);
