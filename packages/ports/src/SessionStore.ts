// @awthaq/ports — SessionStore
//
// Plan 02 (ADR-EA-041, ADR-EA-014): the store port under `Sessions`. `Sessions` (core) owns every
// domain rule: the `id.secret` token and its hashing, the proof-before-state order (PIL-007), the
// absolute and idle expiries, the throttled touch, the rotation and its grace window, reuse
// detection, the concurrent-session policy, the events, the legacy bridge. This port owns only
// persistence, and every primitive is atomic by contract, on every adapter (`StoreContract.sessions`).
// A KV backend (ADR-EA-014) is an implementation of these nine primitives that passes that suite.
//
// What the contract fixes, so the domain can rely on it without knowing the adapter:
// - A session is *live* at `now` iff it is not tombstoned and `now` is before both its absolute and
//   its idle expiry (`isLive`, below, the one definition every adapter shares: SMS-002/ESS-005).
// - A tombstoned row (`supersededBy`/`supersededAt`, RRS-003) is never deleted by a rotation: it is the
//   evidence that makes a replayed token detectable as reuse.
// - A store MAY drop a row only once it is past its absolute expiry (a `Ref` adapter prunes above a size
//   threshold, TMS-004); the domain treats an absent row as `SessionNotFound`, so the one visible
//   difference is that a pruned row yields no `auth.session.expired` event.
// - Every primitive but `listLive` is authoritative: `consistency` is only a hint for the one display
//   listing, and an adapter with no replica ignores it (ADR-EA-024).
//
// The `Ref` adapter here is single-process and test-grade (TRBS-005). Production composes the SQL
// adapter (`@awthaq/sql` `SessionStoreSql`) through `Persistence.sql()`.

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { SessionId, UserId } from "./Ids.ts";
import * as PruneExpired from "./PruneExpired.ts";
import type { Consistency, StoreUnavailable } from "./Store.ts";
import * as Tenant from "./Tenant.ts";

/** BEH-EA-209: the identity a session was minted on behalf of. */
export interface ActingAs {
  readonly type: string;
  readonly id: string;
}

/** The persisted image of a session. `amr` is opaque strings here: the domain narrows with its own `isAuthMethod`. */
export interface SessionRecord {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly secretHash: string;
  readonly createdAt: DateTime.Utc;
  /** Ticket 15: when the session last proved a credential; advanced only by `reauthenticate`. */
  readonly authenticatedAt: DateTime.Utc;
  readonly lastActiveAt: DateTime.Utc;
  readonly absoluteExpiresAt: DateTime.Utc;
  readonly idleExpiresAt: DateTime.Utc;
  readonly ipAddress: Option.Option<string>;
  readonly userAgent: Option.Option<string>;
  readonly actingAs: Option.Option<ActingAs>;
  readonly amr: ReadonlyArray<string>;
  /** Stamped by the adapter from the ambient tenant (BEH-EA-231). */
  readonly tenantId: Option.Option<string>;
  /** RRS-005: the hash the last rotation replaced, accepted until `previousSecretExpiresAt`. */
  readonly previousSecretHash: Option.Option<string>;
  readonly previousSecretExpiresAt: Option.Option<DateTime.Utc>;
  /** RRS-003: the founding session's id; a rotation inherits it. */
  readonly familyId: SessionId;
  readonly supersededBy: Option.Option<SessionId>;
  readonly supersededAt: Option.Option<DateTime.Utc>;
  readonly reusedAt: Option.Option<DateTime.Utc>;
}

/** What `insert` writes. The store adds the tenant, the family and the tombstone fields. */
export interface NewSession {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly secretHash: string;
  /** `createdAt`, `authenticatedAt` and `lastActiveAt` all take this instant (one clock reading). */
  readonly at: DateTime.Utc;
  readonly absoluteExpiresAt: DateTime.Utc;
  readonly idleExpiresAt: DateTime.Utc;
  readonly ipAddress: Option.Option<string>;
  /** Already capped by the domain (CSD-003). */
  readonly userAgent: Option.Option<string>;
  readonly actingAs: Option.Option<ActingAs>;
  readonly amr: ReadonlyArray<string>;
}

export type RotateOutcome =
  | { readonly _tag: "Rotated"; readonly session: SessionRecord }
  /** The row as it is now (authoritative), so the caller re-applies liveness. `None` = it is gone. */
  | { readonly _tag: "Lost"; readonly current: Option.Option<SessionRecord> };

export interface InsertOutcome {
  readonly inserted: SessionRecord;
  /** The tombstoned ancestor, as it is now, when `supersedes` named a live row of the same user. */
  readonly superseded: Option.Option<SessionRecord>;
  /** The ids deleted to keep the user at `maxLive` (the user is the inserted session's). */
  readonly evicted: ReadonlyArray<SessionId>;
}

export interface SessionStoreShape {
  /**
   * ATOMIC (one `Ref.modify` / one transaction):
   * 1. when `supersedes` names a row that is not tombstoned AND belongs to `session.userId`, tombstone it
   *    (`supersededBy = session.id`, `supersededAt = session.at`); any other row (foreign, tombstoned,
   *    absent) is "no ancestor" and nothing is tombstoned (INV-EA-018);
   * 2. insert `session`, its `familyId` that of the tombstoned ancestor, else its own id;
   * 3. when `maxLive` is `Some` and `session.actingAs` is `None`, delete the least-recently-active surplus
   *    of the user's OTHER live, non-acting-as sessions (live at `session.at`) so that, with the new one,
   *    at most `maxLive` remain (`evictionOrder` is the reference).
   * Two inserts naming one `supersedes` tombstone it at most once: the loser founds a fresh family. On
   * Postgres READ COMMITTED two racing inserts may leave `maxLive + 1` transiently, and the next insert
   * evicts back; a serializing adapter is exact.
   */
  readonly insert: (input: {
    readonly session: NewSession;
    readonly supersedes: Option.Option<SessionId>;
    readonly maxLive: Option.Option<number>;
  }) => Effect.Effect<InsertOutcome, StoreUnavailable>;
  /** A point read: ALWAYS authoritative (ADR-EA-014, ADR-EA-024). `None` for an absent row. */
  readonly get: (id: SessionId) => Effect.Effect<Option.Option<SessionRecord>, StoreUnavailable>;
  /**
   * COMPARE-AND-SWAP: applies iff the row exists, its `secretHash` is `expectedSecretHash` AND it is not
   * tombstoned; sets the new hash, the previous one and its expiry, `lastActiveAt` and `idleExpiresAt`.
   * Of any number of racing rotations of one hash exactly one is `Rotated`.
   */
  readonly rotate: (input: {
    readonly id: SessionId;
    readonly expectedSecretHash: string;
    readonly secretHash: string;
    readonly previous: Option.Option<{
      readonly hash: string;
      readonly expiresAt: DateTime.Utc;
    }>;
    readonly lastActiveAt: DateTime.Utc;
    readonly idleExpiresAt: DateTime.Utc;
  }) => Effect.Effect<RotateOutcome, StoreUnavailable>;
  /**
   * ONCE-ONLY and ATOMIC (RRS-003): when the row is tombstoned AND `reusedAt` is `None`, sets `reusedAt = at`
   * and deletes every non-tombstoned row sharing its `familyId`, in one unit, and answers the family and the
   * owner; for every other call (live row, already flagged, absent) it does nothing and answers `None`. Of
   * any number of racing calls exactly one is `Some`. Never retried by an adapter: a flag that took effect
   * but was not acknowledged would read as "already flagged" and lose the event.
   */
  readonly flagReuse: (
    id: SessionId,
    at: DateTime.Utc,
  ) => Effect.Effect<
    Option.Option<{ readonly familyId: SessionId; readonly userId: UserId }>,
    StoreUnavailable
  >;
  /**
   * ATOMIC single delete (TIR-008): answers the user the removed row belonged to, or `None` (absent, or,
   * when `owner` is `Some`, owned by someone else: indistinguishable, GC-005). Of two concurrent removes of
   * one row exactly one is `Some`. Never retried by an adapter, for the reason `flagReuse` is not.
   */
  readonly remove: (
    id: SessionId,
    owner: Option.Option<UserId>,
  ) => Effect.Effect<Option.Option<UserId>, StoreUnavailable>;
  /** Deletes every row of `userId`, tombstones included, except `keep`. Resolves to how many went. */
  readonly removeForUser: (
    userId: UserId,
    keep: Option.Option<SessionId>,
  ) => Effect.Effect<number, StoreUnavailable>;
  /**
   * Exactly the user's rows that are live at `now` (`isLive`), in `(createdAt, id)` ascending order, at most
   * `limit`; `truncated` when more exist. `consistency: "eventual"` MAY be served by a replica (ADR-EA-024);
   * every other primitive is authoritative.
   */
  readonly listLive: (input: {
    readonly userId: UserId;
    readonly now: DateTime.Utc;
    readonly limit: number;
    readonly consistency: Consistency;
  }) => Effect.Effect<
    { readonly items: ReadonlyArray<SessionRecord>; readonly truncated: boolean },
    StoreUnavailable
  >;
  /**
   * ATOMIC (BEH-EA-319, THS-003): applies iff the row exists, belongs to `owner` and is live at `at`
   * (`isLive`); sets `authenticatedAt = at` and unions `addAmr` into the stored `amr` (`unionMethods`, so
   * concurrent step-ups both land). `None` leaves the row untouched.
   */
  readonly reauthenticate: (input: {
    readonly id: SessionId;
    readonly owner: UserId;
    readonly at: DateTime.Utc;
    readonly addAmr: ReadonlyArray<string>;
  }) => Effect.Effect<Option.Option<SessionRecord>, StoreUnavailable>;
  /** CSG-003: deletes every row (tombstones included) whose absolute OR idle expiry is before `before`. Adapters may batch. */
  readonly purgeExpired: (before: DateTime.Utc) => Effect.Effect<number, StoreUnavailable>;
}

export class SessionStore extends Context.Service<SessionStore, SessionStoreShape>()(
  "awthaq/ports/SessionStore",
) {}

// ---- the pure contract helpers every adapter and the domain share ---------------------------

/**
 * TIR-003/SMS-002: the one liveness predicate: not tombstoned (RRS-003), and `now` before both the
 * absolute and the idle expiry. `list`, `findOwned`, `isLive` and the concurrent-session cap share it.
 */
export const isLive = (
  row: {
    readonly absoluteExpiresAt: DateTime.Utc;
    readonly idleExpiresAt: DateTime.Utc;
    readonly supersededAt: Option.Option<DateTime.Utc>;
  },
  now: DateTime.Utc,
): boolean =>
  Option.isNone(row.supersededAt) &&
  DateTime.toEpochMillis(now) < DateTime.toEpochMillis(row.absoluteExpiresAt) &&
  DateTime.toEpochMillis(now) < DateTime.toEpochMillis(row.idleExpiresAt);

/**
 * SMS-003: which of a user's existing live, non-impersonation sessions the about-to-be-inserted one
 * evicts: the least-recently-active surplus (ties broken by id) so that `(existing - evicted) + 1 <= limit`.
 */
export const evictionOrder = <Id extends string>(
  limit: number,
  existing: ReadonlyArray<{ readonly id: Id; readonly lastActiveAt: DateTime.Utc }>,
): ReadonlyArray<Id> => {
  const surplus = existing.length + 1 - Math.max(1, limit);
  if (surplus <= 0) return [];
  return [...existing]
    .sort(
      (a, b) =>
        DateTime.toEpochMillis(a.lastActiveAt) - DateTime.toEpochMillis(b.lastActiveAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, surplus)
    .map((row) => row.id);
};

/** THS-003: order-preserving union; a set of methods only ever grows within a session. */
export const unionMethods = <A extends string>(
  existing: ReadonlyArray<A>,
  additions: ReadonlyArray<A>,
): ReadonlyArray<A> => [
  ...existing,
  ...additions.filter(
    (method, index) => !existing.includes(method) && additions.indexOf(method) === index,
  ),
];

/** `(createdAt, id)` ascending, the order `listLive` answers in. */
export const byCreation = (a: SessionRecord, b: SessionRecord): number =>
  DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---- the Ref adapter ------------------------------------------------------------------------

type State = HashMap.HashMap<SessionId, SessionRecord>;

/** Single-process, test-grade (TRBS-005). Each primitive is one `Ref.modify`, so every one is atomic and exact. */
export const layerMemory = Layer.effect(
  SessionStore,
  Effect.gen(function* () {
    const state = yield* Ref.make<State>(HashMap.empty());

    const insert: SessionStoreShape["insert"] = ({ session, supersedes, maxLive }) =>
      Effect.flatMap(Tenant.resolve(Option.none()), (tenantId) =>
        Ref.modify(state, (s): readonly [InsertOutcome, State] => {
          // TMS-004: rows are otherwise removed only on revoke; prune expired ones once the map is large,
          // in the same atomic step.
          const pruned = PruneExpired.pruneExpiredAbove(s, session.at, (r) => r.absoluteExpiresAt);
          const ancestor = Option.filter(
            Option.flatMap(supersedes, (id) => HashMap.get(pruned, id)),
            // INV-EA-018: only a live (untombstoned) row owned by the issuing user can be superseded.
            (row) => Option.isNone(row.supersededAt) && row.userId === session.userId,
          );
          const created: SessionRecord = {
            id: session.id,
            userId: session.userId,
            secretHash: session.secretHash,
            createdAt: session.at,
            authenticatedAt: session.at,
            lastActiveAt: session.at,
            absoluteExpiresAt: session.absoluteExpiresAt,
            idleExpiresAt: session.idleExpiresAt,
            ipAddress: session.ipAddress,
            userAgent: session.userAgent,
            actingAs: session.actingAs,
            amr: session.amr,
            tenantId,
            previousSecretHash: Option.none(),
            previousSecretExpiresAt: Option.none(),
            familyId: Option.match(ancestor, {
              onNone: () => session.id,
              onSome: (row) => row.familyId,
            }),
            supersededBy: Option.none(),
            supersededAt: Option.none(),
            reusedAt: Option.none(),
          };
          const tombstoned = Option.map(ancestor, (row): SessionRecord => ({
            ...row,
            supersededBy: Option.some(session.id),
            supersededAt: Option.some(session.at),
          }));
          const withAncestor = Option.match(tombstoned, {
            onNone: () => pruned,
            onSome: (row) => HashMap.set(pruned, row.id, row),
          });
          // SMS-003: the cap is enforced in this same modify: count the user's other live,
          // non-impersonation sessions and drop the least-recently-active surplus with the insert.
          const evicted =
            Option.isNone(maxLive) || Option.isSome(session.actingAs)
              ? []
              : evictionOrder(
                  maxLive.value,
                  Array.from(HashMap.values(withAncestor)).filter(
                    (row) =>
                      row.userId === session.userId &&
                      isLive(row, session.at) &&
                      Option.isNone(row.actingAs),
                  ),
                );
          const kept = HashMap.filter(withAncestor, (row) => !evicted.includes(row.id));
          return [
            { inserted: created, superseded: tombstoned, evicted },
            HashMap.set(kept, created.id, created),
          ];
        }),
      );

    const get: SessionStoreShape["get"] = (id) => Effect.map(Ref.get(state), HashMap.get(id));

    const rotate: SessionStoreShape["rotate"] = (input) =>
      Ref.modify(state, (s): readonly [RotateOutcome, State] => {
        const current = HashMap.get(s, input.id);
        // A tombstoned row is never rotated: it is the evidence of reuse (S-7).
        if (
          Option.isNone(current) ||
          current.value.secretHash !== input.expectedSecretHash ||
          Option.isSome(current.value.supersededAt)
        ) {
          return [{ _tag: "Lost", current }, s];
        }
        const refreshed: SessionRecord = {
          ...current.value,
          secretHash: input.secretHash,
          previousSecretHash: Option.map(input.previous, (previous) => previous.hash),
          previousSecretExpiresAt: Option.map(input.previous, (previous) => previous.expiresAt),
          lastActiveAt: input.lastActiveAt,
          idleExpiresAt: input.idleExpiresAt,
        };
        return [{ _tag: "Rotated", session: refreshed }, HashMap.set(s, input.id, refreshed)];
      });

    const flagReuse: SessionStoreShape["flagReuse"] = (id, at) =>
      Ref.modify(state, (s) => {
        const row = HashMap.get(s, id);
        if (
          Option.isNone(row) ||
          Option.isNone(row.value.supersededAt) ||
          Option.isSome(row.value.reusedAt)
        ) {
          return [Option.none<{ readonly familyId: SessionId; readonly userId: UserId }>(), s];
        }
        const familyId = row.value.familyId;
        const flagged = HashMap.set(s, id, { ...row.value, reusedAt: Option.some(at) });
        // A confirmed-compromised family has no live lineage worth keeping; the tombstones stay as evidence.
        return [
          Option.some({ familyId, userId: row.value.userId }),
          HashMap.filter(flagged, (r) => r.familyId !== familyId || Option.isSome(r.supersededAt)),
        ];
      });

    const remove: SessionStoreShape["remove"] = (id, owner) =>
      Ref.modify(state, (s) => {
        const row = HashMap.get(s, id);
        if (Option.isNone(row) || (Option.isSome(owner) && row.value.userId !== owner.value)) {
          return [Option.none<UserId>(), s];
        }
        return [Option.some(row.value.userId), HashMap.remove(s, id)];
      });

    const removeForUser: SessionStoreShape["removeForUser"] = (userId, keep) =>
      Ref.modify(state, (s) => {
        const kept = HashMap.filter(
          s,
          (row, id) => row.userId !== userId || (Option.isSome(keep) && keep.value === id),
        );
        return [HashMap.size(s) - HashMap.size(kept), kept];
      });

    const listLive: SessionStoreShape["listLive"] = ({ userId, now, limit }) =>
      Effect.map(Ref.get(state), (s) => {
        const live = Array.from(HashMap.values(s))
          .filter((row) => row.userId === userId && isLive(row, now))
          .sort(byCreation);
        return { items: live.slice(0, limit), truncated: live.length > limit };
      });

    const reauthenticate: SessionStoreShape["reauthenticate"] = ({ id, owner, at, addAmr }) =>
      Ref.modify(state, (s) => {
        const current = Option.filter(
          HashMap.get(s, id),
          (row) => row.userId === owner && isLive(row, at),
        );
        if (Option.isNone(current)) return [Option.none<SessionRecord>(), s];
        const refreshed: SessionRecord = {
          ...current.value,
          authenticatedAt: at,
          amr: unionMethods(current.value.amr, addAmr),
        };
        return [Option.some(refreshed), HashMap.set(s, id, refreshed)];
      });

    const purgeExpired: SessionStoreShape["purgeExpired"] = (before) =>
      Ref.modify(state, (s) => {
        const cutoff = DateTime.toEpochMillis(before);
        const kept = HashMap.filter(
          s,
          (row) =>
            DateTime.toEpochMillis(row.absoluteExpiresAt) >= cutoff &&
            DateTime.toEpochMillis(row.idleExpiresAt) >= cutoff,
        );
        return [HashMap.size(s) - HashMap.size(kept), kept];
      });

    return SessionStore.of({
      insert,
      get,
      rotate,
      flagReuse,
      remove,
      removeForUser,
      listLive,
      reauthenticate,
      purgeExpired,
    });
  }),
);
