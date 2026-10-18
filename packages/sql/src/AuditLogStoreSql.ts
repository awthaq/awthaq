// @awthaq/sql — AuditLogStoreSql
//
// Plan 02 / plan 16 (ADR-EA-041): the SQL adapter of `@awthaq/ports`' `AuditLogStore`. It owns every
// statement over `auth_audit_log` (moved verbatim from the former `Repositories.ts`), the tenant
// stamp (`Tenant.resolve`: an explicit value wins, then the ambient one, then NULL, BEH-EA-231), the
// ADR-EA-037 savepoint around `append`, the `FOR UPDATE` dialect branch of the erasure rewrite, the
// read routing of the history listings (ADR-EA-024) and the failure classification. Every primitive
// runs through `SqlStore.write`/`read`, which classify a failure as `StoreUnavailable` (naming the
// primitive) and retry a transient write at the top level only.
//
// One `auth_audit_log` row per `AuthEvent`: envelope columns plus an opaque `payload`, the same
// "opaque JSON blob, typed envelope around it" shape `verification_tokens` uses, not
// `SqlModel.makeRepository` (which assumes a flat per-entity row; `AuthEvent` is a closed,
// many-variant union).
//
// Atomicity, per primitive:
// - `append`: one `INSERT ... ON CONFLICT (id) DO NOTHING`, so a duplicate `eventId` is `false`,
//   never an error, and never aborts an enclosing Postgres transaction (inside a transaction the
//   insert runs in a savepoint, ADR-EA-037). Not wrapped in `captureToken`: an append runs on every
//   event, and the extra `pg_current_wal_insert_lsn()` per event costs more than it buys;
//   `AuditLog.list` stays eventual and stale-tolerant by classification (ADR-EA-024).
// - `rewriteReferencing`: one transaction (a savepoint inside a caller's), taking the rows
//   `FOR UPDATE` on Postgres, so it is all-or-nothing and cannot race a concurrent rewrite.
// - `deleteBefore`: bounded batches (CSG-003/ALF-010), each its own statement. The port's `eventTags`
//   is non-empty by type, so `IN ()` (a syntax error on Postgres) cannot be sent.

import { AuditLogStore, SqlTransaction, Tenant } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { traced } from "./internal/traced.ts";
import { makeModels, resolveDialect } from "./Models.ts";
import * as ReadRouting from "./ReadRouting.ts";
import * as SqlStore from "./SqlStore.ts";

/** One `auth_audit_log` row as the statements return it; mapped once, by `toAuditRow`, to the port's record. */
interface AuditLogRow {
  readonly id: string;
  readonly eventTag: string;
  readonly actorUserId: string | null;
  readonly occurredAt: AuditLogStore.AuditRow["occurredAt"];
  readonly correlationId: string | null;
  readonly tenantId: string | null;
  /** The stored envelope as JSON text. The store keeps it opaque; `AuditLog` (core) owns the codec. */
  readonly payload: string;
}

const toAuditRow = (row: AuditLogRow): AuditLogStore.AuditRow => ({
  id: row.id,
  eventTag: row.eventTag,
  actorUserId: Option.fromNullOr(row.actorUserId),
  occurredAt: row.occurredAt,
  correlationId: Option.fromNullOr(row.correlationId),
  tenantId: Option.fromNullOr(row.tenantId),
  payloadJson: row.payload,
});

// The id is matched as a literal substring of the JSON text: escape LIKE's own wildcards.
const likeEscape = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The SQL adapter. Requires the client its statements and its rewrite transaction run on. */
export const layer = Layer.effect(
  AuditLogStore.AuditLogStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const dialect = yield* resolveDialect(sql);
    const models = makeModels(dialect);
    const { write, read } = SqlStore.make(sql);

    const insertQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: Schema.String,
        eventTag: Schema.String,
        actorUserId: Schema.NullOr(Schema.String),
        tenantId: Schema.NullOr(Schema.String),
        occurredAt: models.wire.dateTime,
        correlationId: Schema.NullOr(Schema.String),
        payload: Schema.String,
      }),
      Result: Schema.Struct({ id: Schema.String }),
      execute: (r) => sql`
        INSERT INTO auth_audit_log (id, "eventTag", "actorUserId", "tenantId", "occurredAt", "correlationId", payload)
        VALUES (${r.id}, ${r.eventTag}, ${r.actorUserId}, ${r.tenantId}, ${r.occurredAt}, ${r.correlationId}, ${r.payload})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `,
    });

    // RRC-001: a history listing — replica-eligible, and `"eventual"` by
    // default (a fiber that just wrote is held to the primary by its causal
    // token; pass `"authoritative"` to force the primary regardless).
    const router = yield* ReadRouting.makeRouter;
    const listOn = router.route((client) =>
      SqlSchema.findAll({
        Request: Schema.Struct({
          eventTag: Schema.NullOr(Schema.String),
          actorUserId: Schema.NullOr(Schema.String),
          occurredAfter: models.wire.nullableDateTime,
          occurredBefore: models.wire.nullableDateTime,
        }),
        Result: models.AuditLogRow,
        execute: (r) => {
          const conditions = [
            ...(r.eventTag === null ? [] : [client`"eventTag" = ${r.eventTag}`]),
            ...(r.actorUserId === null ? [] : [client`"actorUserId" = ${r.actorUserId}`]),
            ...(r.occurredAfter === null ? [] : [client`"occurredAt" >= ${r.occurredAfter}`]),
            ...(r.occurredBefore === null ? [] : [client`"occurredAt" <= ${r.occurredBefore}`]),
          ];
          // ESA-002: `id` (a time-ordered uuidv7, monotonic within a process) breaks
          // ties, so two events in one millisecond list in a deterministic order.
          return client`SELECT * FROM auth_audit_log WHERE ${client.and(conditions)} ORDER BY "occurredAt" DESC, id DESC`;
        },
      }),
    );

    // ESA-003: one page of the log in ascending `id` order, strictly after `after` when given — the
    // cursor read `AuditLog.replay` pages with. Ids compare as bytes (Postgres: `COLLATE "C"`), so a
    // locale never reorders a replay. Replica-eligible like the listing.
    const pageOn = router.route((client) =>
      SqlSchema.findAll({
        Request: Schema.Struct({
          after: Schema.NullOr(Schema.String),
          eventTag: Schema.NullOr(Schema.String),
          limit: Schema.Number,
        }),
        Result: models.AuditLogRow,
        execute: (r) => {
          // Byte order, not the database's locale: a replay's checkpoint is an id comparison.
          const id = dialect === "pg" ? client`id COLLATE "C"` : client`id`;
          const conditions = [
            ...(r.after === null ? [] : [client`${id} > ${r.after}`]),
            ...(r.eventTag === null ? [] : [client`"eventTag" = ${r.eventTag}`]),
          ];
          return client`SELECT * FROM auth_audit_log WHERE ${client.and(conditions)} ORDER BY ${id} ASC LIMIT ${r.limit}`;
        },
      }),
    );

    // ESA-005: every row that names `userId` — as its actor, or anywhere in its payload — read from
    // the primary (an erasure must see every row). The payload match is a substring test over the
    // stored JSON text; ids are uuid-shaped, so a hit is a reference. `lock` (Postgres `FOR UPDATE`,
    // a no-op elsewhere) holds the rows for the rest of the enclosing transaction, so the rewrite
    // that follows cannot race a concurrent one.
    const referencingQuery = SqlSchema.findAll({
      Request: Schema.Struct({
        userId: Schema.String,
        pattern: Schema.String,
        lock: Schema.Boolean,
      }),
      Result: models.AuditLogRow,
      execute: (r) =>
        r.lock && dialect === "pg"
          ? sql`SELECT * FROM auth_audit_log WHERE "actorUserId" = ${r.userId} OR payload LIKE ${r.pattern} ESCAPE '\\' ORDER BY id FOR UPDATE`
          : sql`SELECT * FROM auth_audit_log WHERE "actorUserId" = ${r.userId} OR payload LIKE ${r.pattern} ESCAPE '\\'`,
    });

    // ESA-005: rewrites one row's actor and payload in place (erasure pseudonymization); id, tag,
    // time and correlation are untouched.
    const rewriteQuery = SqlSchema.void({
      Request: Schema.Struct({
        id: Schema.String,
        actorUserId: Schema.NullOr(Schema.String),
        payload: Schema.String,
      }),
      execute: (r) =>
        sql`UPDATE auth_audit_log SET "actorUserId" = ${r.actorUserId}, payload = ${r.payload} WHERE id = ${r.id}`,
    });

    // ALF-010: retention. Deletes up to `limit` rows that occurred before `cutoff` — only those
    // whose tag is in `eventTags` when it is given, and never those in `exceptTags`. The
    // `occurredAt` index (core migration 26) serves the range.
    const deleteOccurredBeforeQuery = SqlSchema.findAll({
      Request: Schema.Struct({
        cutoff: models.wire.dateTime,
        eventTags: Schema.NullOr(Schema.Array(Schema.String)),
        exceptTags: Schema.Array(Schema.String),
        limit: Schema.Number,
      }),
      Result: Schema.Struct({ id: Schema.String }),
      execute: (r) => {
        const conditions = [
          sql`"occurredAt" < ${r.cutoff}`,
          ...(r.eventTags === null ? [] : [sql`"eventTag" IN ${sql.in(r.eventTags)}`]),
          ...(r.exceptTags.length === 0 ? [] : [sql`"eventTag" NOT IN ${sql.in(r.exceptTags)}`]),
        ];
        return sql`
          DELETE FROM auth_audit_log
          WHERE id IN (
            SELECT id FROM auth_audit_log WHERE ${sql.and(conditions)} LIMIT ${r.limit}
          )
          RETURNING id
        `;
      },
    });

    // ADR-EA-037: inside a transaction the insert runs in a savepoint. On Postgres a failed
    // statement aborts the whole transaction, so without one a failed audit write would take the
    // operation down with it even under `AuthEvents`' `"bestEffort"` policy (ADR-EA-028).
    // Outside a transaction there is nothing to abort, so no savepoint (and no extra round trips).
    const inSavepoint = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(Effect.serviceOption(sql.transactionService), (open) =>
        Option.isSome(open) ? SqlTransaction.transactional(sql)(effect) : effect,
      );

    return AuditLogStore.AuditLogStore.of({
      append: (row) =>
        Tenant.resolve(row.tenantId).pipe(
          Effect.flatMap((tenantId) =>
            inSavepoint(
              insertQuery({
                id: row.id,
                eventTag: row.eventTag,
                actorUserId: Option.getOrNull(row.actorUserId),
                occurredAt: row.occurredAt,
                correlationId: Option.getOrNull(row.correlationId),
                tenantId: Option.getOrNull(tenantId),
                payload: row.payloadJson,
              }),
            ),
          ),
          Effect.map(Option.isSome),
          traced("AuditLog.insertIfAbsent", { id: row.id, eventTag: row.eventTag }),
          write("AuditLogStore.append"),
        ),

      select: (filter, consistency) =>
        listOn(consistency).pipe(
          Effect.flatMap((query) =>
            query({
              eventTag: Option.getOrNull(filter.eventTag),
              actorUserId: Option.getOrNull(filter.actorUserId),
              occurredAfter: Option.getOrNull(filter.from),
              occurredBefore: Option.getOrNull(filter.to),
            }),
          ),
          traced("AuditLog.list"),
          Effect.map((rows) => rows.map(toAuditRow)),
          read("AuditLogStore.select"),
        ),

      pageAfter: (input, consistency) =>
        pageOn(consistency).pipe(
          Effect.flatMap((query) =>
            query({
              after: Option.getOrNull(input.after),
              eventTag: Option.getOrNull(input.eventTag),
              limit: input.limit,
            }),
          ),
          traced("AuditLog.page"),
          Effect.map((rows) => rows.map(toAuditRow)),
          read("AuditLogStore.pageAfter"),
        ),

      rewriteReferencing: (userId, rewrite) =>
        SqlTransaction.transactional(sql)(
          Effect.gen(function* () {
            const rows = yield* referencingQuery({
              userId,
              pattern: `%${likeEscape(userId)}%`,
              lock: true,
            }).pipe(traced("AuditLog.listReferencing"));
            let rewritten = 0;
            for (const row of rows) {
              const replacement = rewrite(toAuditRow(row));
              if (Option.isNone(replacement)) continue;
              yield* rewriteQuery({
                id: row.id,
                actorUserId: Option.getOrNull(replacement.value.actorUserId),
                payload: replacement.value.payloadJson,
              }).pipe(traced("AuditLog.rewrite", { id: row.id }));
              rewritten += 1;
            }
            return rewritten;
          }),
        ).pipe(write("AuditLogStore.rewriteReferencing")),

      deleteBefore: (input) =>
        SqlStore.drainBatches((limit) =>
          deleteOccurredBeforeQuery({
            cutoff: input.cutoff,
            eventTags: Option.getOrNull(input.eventTags),
            exceptTags: input.exceptTags,
            limit,
          }).pipe(
            Effect.map((rows) => rows.length),
            traced("AuditLog.deleteOccurredBefore"),
            write("AuditLogStore.deleteBefore"),
          ),
        ),
    });
  }),
);
