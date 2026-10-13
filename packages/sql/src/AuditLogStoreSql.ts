// @awthaq/sql — AuditLogStoreSql
//
// Plan 02 (ADR-EA-041): the SQL adapter of `@awthaq/ports`' `AuditLogStore`, built over
// `AuditLogRepository` (so the table, its migration and `ReadRouting` are unchanged). Every
// primitive runs through `SqlStore.write`/`read`, which classify a failure as `StoreUnavailable`
// (naming the primitive) and retry a transient write at the top level only.
//
// Atomicity, per primitive:
// - `append`: one `INSERT ... ON CONFLICT (id) DO NOTHING`, so a duplicate `eventId` is `false`,
//   never an error, and never aborts an enclosing Postgres transaction (inside a transaction the
//   repository runs the insert in a savepoint, ADR-EA-037). Not wrapped in `captureToken`: an
//   append runs on every event, and the extra `pg_current_wal_insert_lsn()` per event costs more
//   than it buys; `AuditLog.list` stays eventual and stale-tolerant by classification (ADR-EA-024).
// - `rewriteReferencing`: one transaction (a savepoint inside a caller's), taking the rows
//   `FOR UPDATE` on Postgres, so it is all-or-nothing and cannot race a concurrent rewrite.
// - `deleteBefore`: bounded batches (CSG-003/ALF-010), each its own statement.

import { AuditLogStore, SqlTransaction } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { AuditLogRepository, type AuditLogRow } from "./Repositories.ts";
import * as SqlStore from "./SqlStore.ts";

const toAuditRow = (row: AuditLogRow): AuditLogStore.AuditRow => ({
  id: row.id,
  eventTag: row.eventTag,
  actorUserId: Option.fromNullOr(row.actorUserId),
  occurredAt: row.occurredAt,
  correlationId: Option.fromNullOr(row.correlationId),
  tenantId: Option.fromNullOr(row.tenantId),
  payloadJson: row.payload,
});

/** The SQL adapter. Requires the audit repository and the client its rewrite transaction runs on. */
export const layer = Layer.effect(
  AuditLogStore.AuditLogStore,
  Effect.gen(function* () {
    const repo = yield* AuditLogRepository;
    const sql = yield* SqlClient.SqlClient;
    const { write, read } = SqlStore.make(sql);

    const append: AuditLogStore.AuditLogStoreShape["append"] = (row) =>
      repo
        .insertIfAbsent({
          id: row.id,
          eventTag: row.eventTag,
          actorUserId: Option.getOrNull(row.actorUserId),
          occurredAt: row.occurredAt,
          correlationId: Option.getOrNull(row.correlationId),
          // An explicit tenant wins; with none the repository stamps the ambient one.
          tenantId: Option.getOrNull(row.tenantId),
          payload: row.payloadJson,
        })
        .pipe(write("AuditLogStore.append"));

    const select: AuditLogStore.AuditLogStoreShape["select"] = (filter, consistency) =>
      repo
        .list(
          {
            eventTag: Option.getOrNull(filter.eventTag),
            actorUserId: Option.getOrNull(filter.actorUserId),
            occurredAfter: Option.getOrNull(filter.from),
            occurredBefore: Option.getOrNull(filter.to),
          },
          { consistency },
        )
        .pipe(
          Effect.map((rows) => rows.map(toAuditRow)),
          read("AuditLogStore.select"),
        );

    const pageAfter: AuditLogStore.AuditLogStoreShape["pageAfter"] = (input, consistency) =>
      repo
        .page(
          {
            after: Option.getOrNull(input.after),
            eventTag: Option.getOrNull(input.eventTag),
            limit: input.limit,
          },
          { consistency },
        )
        .pipe(
          Effect.map((rows) => rows.map(toAuditRow)),
          read("AuditLogStore.pageAfter"),
        );

    const rewriteReferencing: AuditLogStore.AuditLogStoreShape["rewriteReferencing"] = (
      userId,
      rewrite,
    ) =>
      SqlTransaction.transactional(sql)(
        Effect.gen(function* () {
          const rows = yield* repo.listReferencing(userId, { lock: true });
          let rewritten = 0;
          for (const row of rows) {
            const replacement = rewrite(toAuditRow(row));
            if (Option.isNone(replacement)) continue;
            yield* repo.rewrite({
              id: row.id,
              actorUserId: Option.getOrNull(replacement.value.actorUserId),
              payload: replacement.value.payloadJson,
            });
            rewritten += 1;
          }
          return rewritten;
        }),
      ).pipe(write("AuditLogStore.rewriteReferencing"));

    const deleteBefore: AuditLogStore.AuditLogStoreShape["deleteBefore"] = (input) =>
      SqlStore.drainBatches((limit) =>
        repo
          .deleteOccurredBefore({
            cutoff: input.cutoff,
            eventTags: Option.getOrNull(input.eventTags),
            exceptTags: input.exceptTags,
            limit,
          })
          .pipe(write("AuditLogStore.deleteBefore")),
      );

    return AuditLogStore.AuditLogStore.of({
      append,
      select,
      pageAfter,
      rewriteReferencing,
      deleteBefore,
    });
  }),
);
