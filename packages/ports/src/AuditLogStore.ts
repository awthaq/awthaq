// @awthaq/ports — AuditLogStore
//
// Plan 02 (ADR-EA-041): the store port under `AuditLog`. `AuditLog` (core) owns every domain rule
// of the audit trail: the event-to-row mapping, the one payload codec, the filter validation, the
// scrub that erases a user, the alias, the retention batching. This port owns only persistence,
// and every primitive is atomic by contract, on every adapter (`StoreContract.auditLog`).
//
// The row's `payloadJson` is the event envelope as JSON text. The domain encodes and decodes it;
// the store keeps it opaque and returns exactly what it was given, so the two adapters cannot
// disagree about a payload.
//
// Not built on `AuditChain`: this table is deliberately rewritable under GDPR Art. 17
// (`rewriteReferencing`), which a hash chain would forbid.
//
// The `Ref` adapter here is single-process and test-grade (TRBS-005): it evaporates at process
// exit, exactly the gap BEH-EA-100 exists to close. Production composes the SQL adapter
// (`@awthaq/sql` `AuditLogStoreSql`) through `Persistence.sql()`.

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { NonEmptyReadonlyArray } from "effect/Array";
import type { Consistency, StoreUnavailable } from "./Store.ts";
import * as Tenant from "./Tenant.ts";

/** One audit row: the envelope columns plus the JSON text of the event. */
export interface AuditRow {
  /** The event's own `eventId` (ESA-002): a time-ordered id, and the replay cursor. */
  readonly id: string;
  readonly eventTag: string;
  readonly actorUserId: Option.Option<string>;
  readonly occurredAt: DateTime.Utc;
  readonly correlationId: Option.Option<string>;
  /** An explicit `Some` wins over the ambient tenant (BEH-EA-231); stamped by the adapter. */
  readonly tenantId: Option.Option<string>;
  /** The stored envelope as JSON text; opaque to the store. */
  readonly payloadJson: string;
}

/** Every filter is optional and combines with AND; `from` and `to` are inclusive. */
export interface AuditFilter {
  readonly eventTag: Option.Option<string>;
  readonly actorUserId: Option.Option<string>;
  readonly from: Option.Option<DateTime.Utc>;
  readonly to: Option.Option<DateTime.Utc>;
}

/** What `rewriteReferencing`'s pure function may replace: the actor column and the payload text. */
export interface AuditRewrite {
  readonly actorUserId: Option.Option<string>;
  readonly payloadJson: string;
}

export interface AuditLogStoreShape {
  /**
   * IDEMPOTENT on `id` and ATOMIC: `true` when the row was stored, `false` when a row with that id
   * already exists (a duplicate `eventId` is not an outage, and never aborts an enclosing
   * transaction). Stamps the tenant (`Tenant.resolve`).
   */
  readonly append: (row: AuditRow) => Effect.Effect<boolean, StoreUnavailable>;
  /**
   * Newest first (`occurredAt` descending, then `id` descending). The filter is applied BEFORE any
   * row is returned, so a row outside it is never touched. `consistency: "eventual"` MAY be served
   * by a replica; an adapter with none ignores it.
   */
  readonly select: (
    filter: AuditFilter,
    consistency: Consistency,
  ) => Effect.Effect<ReadonlyArray<AuditRow>, StoreUnavailable>;
  /**
   * At most `limit` rows in ascending `id` order, compared as BYTES (Postgres: `COLLATE "C"`, so a
   * locale never reorders the replay), strictly after `after` when given. Replica-eligible like
   * `select`.
   */
  readonly pageAfter: (
    input: {
      readonly after: Option.Option<string>;
      readonly eventTag: Option.Option<string>;
      readonly limit: number;
    },
    consistency: Consistency,
  ) => Effect.Effect<ReadonlyArray<AuditRow>, StoreUnavailable>;
  /**
   * ALL-OR-NOTHING (ESA-005): every row whose actor equals `userId`, or whose payload text contains
   * it anywhere, is passed to `rewrite` (pure and total: the domain's scrub); a `Some` replaces the
   * row's actor and payload. If `rewrite` dies on any row nothing is changed. Resolves to how many
   * rows were rewritten. Authoritative (an erasure must see every row).
   */
  readonly rewriteReferencing: (
    userId: string,
    rewrite: (row: AuditRow) => Option.Option<AuditRewrite>,
  ) => Effect.Effect<number, StoreUnavailable>;
  /**
   * ALF-010: retention. Deletes every row that occurred strictly before `cutoff`: only rows whose
   * tag is in `eventTags` when it is `Some` (non-empty by type), never rows whose tag is in
   * `exceptTags`. Adapters may batch; resolves to the total.
   */
  readonly deleteBefore: (input: {
    readonly cutoff: DateTime.Utc;
    readonly eventTags: Option.Option<NonEmptyReadonlyArray<string>>;
    readonly exceptTags: ReadonlyArray<string>;
  }) => Effect.Effect<number, StoreUnavailable>;
}

export class AuditLogStore extends Context.Service<AuditLogStore, AuditLogStoreShape>()(
  "awthaq/ports/AuditLogStore",
) {}

// ---- the pure contract helpers every adapter and the domain share ---------------------------

/** `id` ascending, compared as code units: for the ASCII ids the audit trail mints, the same as bytes. */
export const byIdAscending = (a: { readonly id: string }, b: { readonly id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** `occurredAt` descending, ties broken by `id` descending. */
export const newestFirst = (a: AuditRow, b: AuditRow): number =>
  DateTime.toEpochMillis(b.occurredAt) - DateTime.toEpochMillis(a.occurredAt) ||
  (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** The filter, over one row. */
export const matches = (row: AuditRow, filter: AuditFilter): boolean =>
  (Option.isNone(filter.eventTag) || row.eventTag === filter.eventTag.value) &&
  (Option.isNone(filter.actorUserId) ||
    (Option.isSome(row.actorUserId) && row.actorUserId.value === filter.actorUserId.value)) &&
  (Option.isNone(filter.from) ||
    DateTime.toEpochMillis(row.occurredAt) >= DateTime.toEpochMillis(filter.from.value)) &&
  (Option.isNone(filter.to) ||
    DateTime.toEpochMillis(row.occurredAt) <= DateTime.toEpochMillis(filter.to.value));

/** The row names `userId` as its actor or anywhere in its payload text (ids are uuid-shaped, so a hit is a reference). */
export const references = (row: AuditRow, userId: string): boolean =>
  (Option.isSome(row.actorUserId) && row.actorUserId.value === userId) ||
  row.payloadJson.includes(userId);

// ---- the Ref adapter ------------------------------------------------------------------------

/** Single-process, test-grade (TRBS-005). One `Ref` over every row; each primitive is one `Ref.modify`. */
export const layerMemory = Layer.effect(
  AuditLogStore,
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyArray<AuditRow>>([]);

    const append: AuditLogStoreShape["append"] = (row) =>
      Effect.flatMap(Tenant.resolve(row.tenantId), (tenantId) =>
        Ref.modify(state, (rows) =>
          rows.some((existing) => existing.id === row.id)
            ? [false, rows]
            : [true, [...rows, { ...row, tenantId }]],
        ),
      );

    const select: AuditLogStoreShape["select"] = (filter) =>
      Effect.map(Ref.get(state), (rows) =>
        rows.filter((row) => matches(row, filter)).sort(newestFirst),
      );

    const pageAfter: AuditLogStoreShape["pageAfter"] = (input) =>
      Effect.map(Ref.get(state), (rows) =>
        rows
          .filter(
            (row) =>
              (Option.isNone(input.after) || row.id > input.after.value) &&
              (Option.isNone(input.eventTag) || row.eventTag === input.eventTag.value),
          )
          .sort(byIdAscending)
          .slice(0, input.limit),
      );

    const rewriteReferencing: AuditLogStoreShape["rewriteReferencing"] = (userId, rewrite) =>
      Ref.modify(state, (rows) => {
        let rewritten = 0;
        const next = rows.map((row) => {
          if (!references(row, userId)) return row;
          const replacement = rewrite(row);
          if (Option.isNone(replacement)) return row;
          rewritten += 1;
          return { ...row, ...replacement.value };
        });
        return [rewritten, next];
      });

    const deleteBefore: AuditLogStoreShape["deleteBefore"] = (input) =>
      Ref.modify(state, (rows) => {
        const cutoff = DateTime.toEpochMillis(input.cutoff);
        const doomed = (row: AuditRow): boolean =>
          DateTime.toEpochMillis(row.occurredAt) < cutoff &&
          (Option.isNone(input.eventTags) || input.eventTags.value.includes(row.eventTag)) &&
          !input.exceptTags.includes(row.eventTag);
        const kept = rows.filter((row) => !doomed(row));
        return [rows.length - kept.length, kept];
      });

    return AuditLogStore.of({ append, select, pageAfter, rewriteReferencing, deleteBefore });
  }),
);
