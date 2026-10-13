// @awthaq/core — AuditLog
//
// BEH-EA-100: "the record of record" — a durable table for security-relevant
// operations that MUST NOT depend on any `AuthEvents` subscriber. Wayfinder
// map (.scratch/resolve-ready-for-human-findings), ticket 01
// (ALF-001/ESA-001/ESS-002/CSG-004/EP-002): `AuthEvents.publish` itself
// writes through this service before ever touching the `PubSub` — see
// `AuthEvents.ts`'s own `publish` for the choke point this closes.
//
// Plan 02 (ADR-EA-041): one implementation, `layer`, over `@awthaq/ports`' `AuditLogStore` (a `Ref`
// adapter there, a SQL adapter in `@awthaq/sql`). It is keyed by the closed `AuthEvent` union:
// `payload` is an opaque JSON envelope
// (the `verification_tokens.payload` precedent) rather than a 45-variant
// column explosion, so a new `AuthEvent` tag needs no migration to be
// durably recorded.
//
// ESA-007: the stored payload is `{ ...event, version, meta }` — the event as
// its `Schema` encodes it, the stored-shape `version`, and the envelope pieces
// that have no column (trace ids, ip, user agent). Reading decodes it through
// the `AuthEvent` union codec, so `AuditLogRecord.payload` is a typed
// `AuthEvent`, never `unknown`; a row that no longer decodes surfaces as the
// typed `AuditLogDecodeError` (one bad row must not be silently skipped by a
// consumer that means to see everything). `id` is the event's own `eventId`
// (ESA-002), so a subscriber's delivered event joins its row by equality.
//
// MA-004/ADR-EA-028: every method's `E` carries `StoreUnavailable` (a database that is down or
// busy) beside its domain error, for both layers, instead of `layerSql` dying on a `SqlError`.
// Whether an audit-store outage fails the operation that triggered the event is not decided here
// but by `AuthEvents`' explicit `AuditWritePolicy` (default `"bestEffort"`: logged and counted,
// the operation succeeds and the bus still delivers; `"required"`: the operation dies, the
// pre-MA-004 fail-closed behaviour), so it is a choice a deployment can read and make.
//
// ESA-005: `pseudonymizeActor` is the erasure primitive — the rows outlive a
// deleted user (a forensic timeline is worth keeping), but stop naming them.
//
// **Not built on `AuditChain`**: that primitive is for tamper-evidence of a
// table with no erasure story (`ImpersonationRecords`); this table is
// deliberately rewritable under GDPR Art. 17, which a hash chain would forbid.

import { AuditLogStore, Defects } from "@awthaq/ports";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  type AuthEvent,
  type AuthEventTag,
  EVENT_VERSION,
  type Published,
  actorOf,
  decodeEvent,
  encodeEvent,
  piiFieldsOf,
  upcastPayload,
} from "./AuthEventSchemas.ts";
import { relabel, type StoreUnavailable } from "./Errors.ts";
import { UserId } from "./Users.ts";

/** ESA-007: a stored row that no longer decodes as an `AuthEvent` — a schema drift or a hand-edited row. */
export class AuditLogDecodeError extends Data.TaggedError("AuditLogDecodeError")<{
  readonly id: string;
  readonly eventTag: string;
  readonly message: string;
}> {}

export interface AuditLogRecord {
  /** The event's own `eventId` (ESA-002) — a time-ordered id, and `replay`'s cursor. */
  readonly id: string;
  readonly eventTag: AuthEventTag;
  readonly actorUserId: Option.Option<UserId>;
  readonly occurredAt: DateTime.Utc;
  readonly correlationId: Option.Option<string>;
  readonly traceId: Option.Option<string>;
  readonly spanId: Option.Option<string>;
  readonly ip: Option.Option<string>;
  readonly userAgent: Option.Option<string>;
  /** The tenant the row was stamped with (BEH-EA-231); `None` for a single-tenant deployment or a historic row. */
  readonly tenantId: Option.Option<string>;
  /** The decoded event (ESA-007). */
  readonly payload: AuthEvent;
}

/** The delivered-event view of a stored row: the same `eventId`/`occurredAt` a live subscriber saw. */
export const toPublished = (record: AuditLogRecord): Published => ({
  ...record.payload,
  eventId: record.id,
  occurredAt: record.occurredAt,
  correlationId: record.correlationId,
  traceId: record.traceId,
  spanId: record.spanId,
  ip: record.ip,
  userAgent: record.userAgent,
  tenantId: record.tenantId,
});

export interface AuditLogListInput {
  readonly eventTag?: AuthEventTag;
  readonly actorUserId?: UserId;
  readonly occurredAfter?: DateTime.Utc;
  readonly occurredBefore?: DateTime.Utc;
}

export interface AuditLogReplayInput {
  /** Exclusive cursor: an `eventId`/row `id` the consumer has already handled. Omit to start at the beginning. */
  readonly after?: string;
  readonly eventTag?: AuthEventTag;
  /** Rows fetched per round trip; default 500. */
  readonly batchSize?: number;
}

export interface AuditLogShape {
  /** Called by `AuthEvents.publish` for every event, after it is stamped, before it is enqueued. */
  readonly record: (event: Published) => Effect.Effect<void, StoreUnavailable>;
  /** Newest-first (ties broken by id); every filter is optional and combines with AND. */
  readonly list: (
    input?: AuditLogListInput,
  ) => Effect.Effect<ReadonlyArray<AuditLogRecord>, AuditLogDecodeError | StoreUnavailable>;
  /**
   * ESA-003: the recovery path for the at-most-once bus. An ascending,
   * cursor-based read over the whole log — a consumer keeps the last `id` it
   * handled as a checkpoint, `replay({ after })`s to backfill, then tails the
   * live stream (deduplicating on `eventId`). Pages internally; ordering is
   * publish order within one process and millisecond-granular across processes.
   */
  readonly replay: (
    input?: AuditLogReplayInput,
  ) => Stream.Stream<AuditLogRecord, AuditLogDecodeError | StoreUnavailable>;
  /**
   * ESA-005: erasure. Rewrites every row that names `userId` (as actor, or
   * anywhere in its payload): the id becomes a fresh random alias — the same
   * alias across all of that user's rows, so "one actor did these things"
   * survives, and unrelated to the id — and the declared free-text fields
   * (each event's declared `pii`) are blanked. Row id, tag, timestamp and correlation are kept.
   * Idempotent; resolves to how many rows were rewritten.
   */
  readonly pseudonymizeActor: (userId: UserId) => Effect.Effect<number, StoreUnavailable>;
  /**
   * ALF-010: retention. Deletes every row that occurred before `before` — only rows
   * whose tag is in `eventTags` when given, never rows whose tag is in `exceptTags` —
   * and resolves to how many went. Nothing calls it unless an operator configures a
   * window (`Retention`'s `auditLog`): the default keeps the trail forever.
   */
  readonly purge: (input: {
    readonly before: DateTime.Utc;
    readonly eventTags?: ReadonlyArray<AuthEventTag>;
    readonly exceptTags?: ReadonlyArray<AuthEventTag>;
  }) => Effect.Effect<number, StoreUnavailable>;
}

export class AuditLog extends Context.Service<AuditLog, AuditLogShape>()("awthaq/core/AuditLog") {}

// ---- the stored row -----------------------------------------------------------

/** The pieces of the stored envelope that have no column of their own. */
const StoredMeta = Schema.Struct({
  version: Schema.optional(Schema.Number),
  meta: Schema.optional(
    Schema.Struct({
      traceId: Schema.optional(Schema.String),
      spanId: Schema.optional(Schema.String),
      ip: Schema.optional(Schema.String),
      userAgent: Schema.optional(Schema.String),
    }),
  ),
});
const decodeStoredMeta = Schema.decodeUnknownEffect(StoredMeta);

/** Event → the row `record` persists. `Schema.encodeEffect` keeps only the event's own fields, so the envelope keys never leak into the payload. */
const toStoredRow = (published: Published): Effect.Effect<AuditLogStore.AuditRow> =>
  Effect.map(Effect.orDie(encodeEvent(published)), (encoded) => ({
    id: published.eventId,
    eventTag: published._tag,
    actorUserId: Option.map(actorOf(published), UserId),
    occurredAt: published.occurredAt,
    correlationId: published.correlationId,
    tenantId: published.tenantId,
    payloadJson: JSON.stringify({
      ...encoded,
      version: EVENT_VERSION,
      meta: {
        ...Option.match(published.traceId, {
          onNone: () => ({}),
          onSome: (traceId) => ({ traceId }),
        }),
        ...Option.match(published.spanId, { onNone: () => ({}), onSome: (spanId) => ({ spanId }) }),
        ...Option.match(published.ip, { onNone: () => ({}), onSome: (ip) => ({ ip }) }),
        ...Option.match(published.userAgent, {
          onNone: () => ({}),
          onSome: (userAgent) => ({ userAgent }),
        }),
      },
    }),
  }));

/** The stored JSON text as a value, or `None` when it is not JSON at all. */
const parseJson = (text: string): Option.Option<unknown> => {
  try {
    const parsed: unknown = JSON.parse(text);
    return Option.some(parsed);
  } catch {
    return Option.none();
  }
};

const decodeRow = (
  row: AuditLogStore.AuditRow,
): Effect.Effect<AuditLogRecord, AuditLogDecodeError> =>
  Effect.gen(function* () {
    const failed = (error: unknown) =>
      new AuditLogDecodeError({
        id: row.id,
        eventTag: row.eventTag,
        message: `awthaq: audit row ${row.id} ("${row.eventTag}") does not decode as an AuthEvent: ${String(error)}`,
      });
    const parsed = parseJson(row.payloadJson);
    if (Option.isNone(parsed)) return yield* failed("the stored payload is not JSON");
    const stored = yield* decodeStoredMeta(parsed.value).pipe(Effect.mapError(failed));
    const payload = yield* decodeEvent(upcastPayload(stored.version ?? 1, parsed.value)).pipe(
      Effect.mapError(failed),
    );
    return {
      id: row.id,
      eventTag: payload._tag,
      actorUserId: Option.map(row.actorUserId, UserId),
      occurredAt: row.occurredAt,
      correlationId: row.correlationId,
      traceId: Option.fromNullishOr(stored.meta?.traceId),
      spanId: Option.fromNullishOr(stored.meta?.spanId),
      ip: Option.fromNullishOr(stored.meta?.ip),
      userAgent: Option.fromNullishOr(stored.meta?.userAgent),
      tenantId: row.tenantId,
      payload,
    };
  });

/** Replaces `from` with `to` inside every string of a JSON value (ids appear both bare and as `prefix:<id>` substrings). */
const replaceDeep = (value: unknown, from: string, to: string): unknown => {
  if (typeof value === "string") return value.replaceAll(from, to);
  if (Array.isArray(value)) return value.map((item) => replaceDeep(item, from, to));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceDeep(item, from, to)]),
    );
  }
  return value;
};

const blankFields = (value: unknown, fields: ReadonlyArray<string>): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, fields.includes(key) ? "" : item]),
      )
    : value;

/**
 * ESA-005: what erasing `userId` does to one row the store found referencing them. The alias is
 * substituted everywhere and the free-text fields (each event's declared `pii`) are blanked. `None`
 * when that changes nothing, so a rerun counts zero rows. Pure and total, because the store
 * applies it inside its own atomic unit; written once, so both adapters scrub identically.
 */
const scrubRow =
  (userId: string, alias: string) =>
  (row: AuditLogStore.AuditRow): Option.Option<AuditLogStore.AuditRewrite> => {
    const parsed = parseJson(row.payloadJson);
    const payloadJson = Option.match(parsed, {
      // Not JSON (a hand-edited row): all that can be done is to replace the id in the text.
      onNone: () => row.payloadJson.replaceAll(userId, alias),
      onSome: (payload) =>
        JSON.stringify(blankFields(replaceDeep(payload, userId, alias), piiFieldsOf(row.eventTag))),
    });
    const actorUserId = Option.map(row.actorUserId, (actor) => actor.replaceAll(userId, alias));
    return payloadJson === row.payloadJson && Equal.equals(actorUserId, row.actorUserId)
      ? Option.none()
      : Option.some({ actorUserId, payloadJson });
  };

const DEFAULT_BATCH = 500;

/** L-5: a replay's page size is a positive integer; anything else would drop, skip or fail a page. */
const validBatchSize = (batchSize: number | undefined): Effect.Effect<number> =>
  batchSize === undefined
    ? Effect.succeed(DEFAULT_BATCH)
    : Number.isInteger(batchSize) && batchSize >= 1
      ? Effect.succeed(batchSize)
      : Defects.invalidConfiguration(
          "AuditLog.replay.batchSize",
          `awthaq: batchSize must be a positive integer, got ${batchSize}`,
        );

/** A fresh alias, unrelated to the id it replaces — so nothing can be derived back from it. */
const newAlias = Effect.map(
  Effect.all([Random.nextIntBetween(0, 0xffffffff), Random.nextIntBetween(0, 0xffffffff)]),
  ([a, b]) => `erased-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`,
);

// ---- the one implementation -----------------------------------------------------

/**
 * Written once over `AuditLogStore` (ADR-EA-041). It needs nothing else: the row id is the event's
 * own `eventId`, minted in `publish`, so `AuthEvents.layer` can sit on top of it everywhere it is
 * composed without pulling a crypto dependency into every composition.
 */
export const layer = Layer.effect(
  AuditLog,
  Effect.gen(function* () {
    const store = yield* AuditLogStore.AuditLogStore;

    const record: AuditLogShape["record"] = (event) =>
      toStoredRow(event).pipe(
        Effect.flatMap(store.append),
        Effect.asVoid,
        relabel("AuditLog.record"),
      );

    const list: AuditLogShape["list"] = (input) =>
      store
        .select(
          {
            eventTag: Option.fromNullishOr(input?.eventTag),
            actorUserId: Option.fromNullishOr(input?.actorUserId),
            from: Option.fromNullishOr(input?.occurredAfter),
            to: Option.fromNullishOr(input?.occurredBefore),
          },
          // A history listing is replica-eligible by classification (ADR-EA-024).
          "eventual",
        )
        .pipe(
          relabel("AuditLog.list"),
          // L-1: the store applies the filter, so only the rows asked for are decoded.
          Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
        );

    const replay: AuditLogShape["replay"] = (input) =>
      Stream.unwrap(
        Effect.map(validBatchSize(input?.batchSize), (limit) =>
          Stream.paginate(Option.fromNullishOr(input?.after), (after: Option.Option<string>) =>
            store
              .pageAfter(
                { after, eventTag: Option.fromNullishOr(input?.eventTag), limit },
                "eventual",
              )
              .pipe(
                relabel("AuditLog.replay"),
                Effect.flatMap((rows) => {
                  const last = rows.at(-1);
                  return Effect.forEach(rows, decodeRow).pipe(
                    Effect.map((records) => [
                      records,
                      last === undefined
                        ? Option.none<Option.Option<string>>()
                        : Option.some(Option.some(last.id)),
                    ]),
                  );
                }),
              ),
          ),
        ),
      );

    const pseudonymizeActor: AuditLogShape["pseudonymizeActor"] = (userId) =>
      Effect.flatMap(newAlias, (alias) =>
        store.rewriteReferencing(userId, scrubRow(userId, alias)),
      ).pipe(relabel("AuditLog.pseudonymizeActor"));

    const purge: AuditLogShape["purge"] = (input) => {
      const exceptTags = input.exceptTags ?? [];
      // L-4: an empty allow-list names no tag, so it matches nothing (it is not "every tag").
      if (input.eventTags === undefined) {
        return store
          .deleteBefore({ cutoff: input.before, eventTags: Option.none(), exceptTags })
          .pipe(relabel("AuditLog.purge"));
      }
      return Arr.isReadonlyArrayNonEmpty(input.eventTags)
        ? store
            .deleteBefore({
              cutoff: input.before,
              eventTags: Option.some(input.eventTags),
              exceptTags,
            })
            .pipe(relabel("AuditLog.purge"))
        : Effect.succeed(0);
    };

    return AuditLog.of({ record, list, replay, pseudonymizeActor, purge });
  }),
);
