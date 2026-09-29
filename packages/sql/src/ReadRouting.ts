// @awthaq/sql — ReadRouting
//
// RRC-001 (wayfinder ticket 28): opt-in, default-off read-replica routing.
//
// Repositories run over one ambient `SqlClient` (BEH-EA-035), and
// `SqlModel.makeRepository` pulls it with a bare `yield* SqlClient`, so a
// repository cannot be handed "the right client for this query" per call.
// Routing is therefore a second, optional ambient service plus a per-fiber
// causal token, not an argument threaded through every call:
//
//   - `ReplicaSqlClient` (a `Context.Reference`, default `Option.none()`)
//     holds the replica client; `ReadRouting.replica(layer)` provides it.
//     Nothing configured means every read uses the primary, byte-for-byte as
//     before.
//   - Every read is classified. The default is `"authoritative"` (primary):
//     anything on the sign-in / session-verify / verification path, because
//     ADR-EA-014 requires revocation and rotation to be authoritative on the
//     very next read. Only display/history listings may ask for `"eventual"`
//     (`Sessions.listByUser(..., { consistency: "eventual" })`, and
//     `AuditLog.list`, which defaults to it).
//   - `CurrentCausalToken` (a fiber-scoped `Context.Reference`) is the
//     read-your-writes guardrail for eventual reads: a domain service wraps a
//     write in `captureToken`, which reads the primary's write position
//     afterwards and sets the token for the rest of the fiber; an eventual
//     read then goes to the replica only if it has replayed past that
//     position, else to the primary. The position source is
//     `ReplicationPosition` (default: Postgres WAL LSNs; a test double
//     replaces it).
//
// Deferred, deliberately (ticket 28 point 4): carrying a token across
// requests (a header seeded into `CurrentCausalToken` by middleware, for a
// redirect landing on another process). `withCausalToken` is the seeding
// primitive that middleware would call.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

/**
 * How stale a read may be. `"authoritative"` (the default everywhere) always
 * reads the primary; `"eventual"` may read the replica when one is configured
 * and read-your-writes allows it.
 */
export type Consistency = "authoritative" | "eventual";

/** Per-call read classification accepted by replica-eligible repository methods. */
export interface ReadOptions {
  readonly consistency?: Consistency;
}

// ---- the replica client -----------------------------------------------------------

/** The replica client when one is configured; `None` (the default) routes every read to the primary. */
export const ReplicaSqlClient = Context.Reference<Option.Option<SqlClient.SqlClient>>(
  "awthaq/sql/ReplicaSqlClient",
  { defaultValue: () => Option.none() },
);

/**
 * Opts in to replica routing: `layer` builds the replica's `SqlClient` and is
 * consumed here, so it never replaces the ambient (primary) `SqlClient`.
 */
export const replica = <E, R>(layer: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Layer.effect(ReplicaSqlClient, Effect.map(SqlClient.SqlClient, Option.some)).pipe(
    Layer.provide(layer),
  );

// ---- causal tokens ------------------------------------------------------------------

/** An opaque position in the primary's write history (a Postgres LSN with the default `ReplicationPosition`). */
export const CausalToken = Schema.String.pipe(Schema.brand("CausalToken"));
export type CausalToken = typeof CausalToken.Type;
const causalToken = Schema.decodeUnknownSync(CausalToken);

/** The token every eventual read on this fiber must be caught up to before it may use the replica. */
export const CurrentCausalToken = Context.Reference<Option.Option<CausalToken>>(
  "awthaq/sql/CurrentCausalToken",
  { defaultValue: () => Option.none() },
);

/** Stands in when the primary's position could not be read: no replica can ever prove it caught up to it. */
const UNKNOWN_POSITION = causalToken("unknown");

export interface ReplicationPositionShape {
  /** The primary's current write position, after a write committed. `None` when the dialect has no such notion. */
  readonly current: (
    primary: SqlClient.SqlClient,
  ) => Effect.Effect<Option.Option<CausalToken>, unknown>;
  /** Has `replica` applied everything up to `token`? Any doubt (an error, an unparsable token) is `false`. */
  readonly hasReplayed: (
    replica: SqlClient.SqlClient,
    token: CausalToken,
  ) => Effect.Effect<boolean, unknown>;
}

const LsnRow = Schema.Struct({ lsn: Schema.String });
const CaughtUpRow = Schema.Struct({ caught_up: Schema.NullOr(Schema.Boolean) });

/** Postgres: `pg_current_wal_insert_lsn()` on the primary; `pg_last_wal_replay_lsn() >= token` on the replica. */
const postgresPosition: ReplicationPositionShape = {
  current: (primary) =>
    primary.onDialectOrElse({
      pg: () =>
        SqlSchema.findOne({
          Request: Schema.Void,
          Result: LsnRow,
          execute: () => primary`SELECT pg_current_wal_insert_lsn()::text AS lsn`,
        })(undefined).pipe(Effect.map((row) => Option.some(causalToken(row.lsn)))),
      orElse: () => Effect.succeed(Option.none<CausalToken>()),
    }),
  hasReplayed: (replica, token) =>
    replica.onDialectOrElse({
      pg: () =>
        SqlSchema.findOne({
          Request: Schema.String,
          Result: CaughtUpRow,
          // NULL (a server not in recovery has no replay position) is "not caught up".
          execute: (lsn) => replica`SELECT pg_last_wal_replay_lsn() >= ${lsn}::pg_lsn AS caught_up`,
        })(token).pipe(Effect.map((row) => row.caught_up === true)),
      orElse: () => Effect.succeed(false),
    }),
};

/** The position source; override it to route on something other than Postgres LSNs (or to inject lag in tests). */
export const ReplicationPosition = Context.Reference<ReplicationPositionShape>(
  "awthaq/sql/ReplicationPosition",
  { defaultValue: () => postgresPosition },
);

/**
 * Runs `effect` (a write, or the transaction around one) and, once it has
 * succeeded, sets `CurrentCausalToken` to the primary's resulting write
 * position for the rest of the current fiber, so later eventual reads on it
 * never observe a state older than this write. Does nothing extra when no
 * replica is configured. A failure to read the position pins the fiber to the
 * primary instead of failing the write.
 */
export const captureToken = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.tap(effect, () =>
    Effect.gen(function* () {
      const replicaClient = yield* ReplicaSqlClient;
      if (Option.isNone(replicaClient)) return;
      const primary = yield* SqlClient.SqlClient;
      const position = yield* ReplicationPosition;
      const token = yield* position
        .current(primary)
        .pipe(Effect.orElseSucceed(() => Option.some(UNKNOWN_POSITION)));
      if (Option.isNone(token)) return;
      yield* Effect.withFiber((fiber) =>
        Effect.sync(() => {
          fiber.setContext(Context.add(fiber.context, CurrentCausalToken, token));
        }),
      );
    }),
  );

/** Seeds `CurrentCausalToken` for `effect` — what a middleware carrying a token across requests would call. */
export const withCausalToken =
  (token: CausalToken) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, CurrentCausalToken, Option.some(token));

// ---- routing --------------------------------------------------------------------------

export type ReadTarget = "primary" | "replica";

export interface ReadRouter {
  /** Where an eventual read would go right now (exposed for operators and tests). */
  readonly target: (consistency: Consistency) => Effect.Effect<ReadTarget>;
  /**
   * Builds a query with `make` against the primary and, when configured, the
   * replica — once, at layer construction — and returns a picker that
   * resolves the right one per call.
   */
  readonly route: <Q>(
    make: (client: SqlClient.SqlClient) => Q,
  ) => (consistency: Consistency) => Effect.Effect<Q>;
}

/** Resolves the primary (`SqlClient`), the optional replica and the position source once. */
export const makeRouter: Effect.Effect<ReadRouter, never, SqlClient.SqlClient> = Effect.gen(
  function* () {
    const primary = yield* SqlClient.SqlClient;
    const replicaClient = yield* ReplicaSqlClient;
    const position = yield* ReplicationPosition;

    const target: ReadRouter["target"] = Effect.fnUntraced(function* (consistency) {
      if (consistency === "authoritative" || Option.isNone(replicaClient)) return "primary";
      const token = yield* CurrentCausalToken;
      if (Option.isNone(token)) return "replica";
      const caughtUp = yield* position
        .hasReplayed(replicaClient.value, token.value)
        .pipe(Effect.orElseSucceed(() => false));
      return caughtUp ? "replica" : "primary";
    });

    const route: ReadRouter["route"] = (make) => {
      const onPrimary = make(primary);
      const onReplica = Option.map(replicaClient, make);
      return (consistency) =>
        target(consistency).pipe(
          Effect.tap((where) => Effect.annotateCurrentSpan("awthaq.read.target", where)),
          Effect.map((where) =>
            where === "replica" && Option.isSome(onReplica) ? onReplica.value : onPrimary,
          ),
        );
    };

    return { target, route };
  },
);
