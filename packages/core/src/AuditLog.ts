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
// adapter there, a SQL adapter in `@awthaq/sql`). `payload` is an opaque JSON envelope
// (the `verification_tokens.payload` precedent) rather than a 45-variant
// column explosion, so a new event tag needs no migration to be
// durably recorded.
//
// ADR-EA-049: the audit log does not depend on the composition. A row is written through the event's
// own definition (core's for `publish`, the plugin's for `emit`), and records what erasure needs when it
// is written: the actor column and the fields the definition declares as personal data (`meta.pii`). A
// row whose tag core does not define is read as a `ForeignEvent` (its tag and stored fields), whether
// its plugin is still composed or was removed; the plugin decodes its own rows with `payloadAs`.
//
// ESA-007: the stored payload is `{ ...event, version, meta }` — the event as
// its `Schema` encodes it, the stored-shape `version`, and the envelope pieces
// that have no column (trace ids, ip, user agent, declared personal data). Reading decodes a core row
// through the `AuthEvent` union codec, so `AuditLogRecord.payload` is a typed
// `AuthEvent | ForeignEvent`, never `unknown`; a core row that no longer decodes surfaces as the
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
  CoreRegistry,
  EVENT_VERSION,
  type ForeignEvent,
  ForeignEventTag,
  type Published,
  type PublishedAny,
  decodeEvent,
  isEventTag,
  piiFieldsOf,
  upcastPayload,
} from "./AuthEventSchemas.ts";
import * as EventDefinition from "./EventDefinition.ts";
import { relabel, type StoreUnavailable } from "./Errors.ts";
import { UserId } from "./Users.ts";

/** ESA-007: a stored core row that no longer decodes as an `AuthEvent`, or a row that is not a JSON object — a schema drift or a hand-edited row. */
export class AuditLogDecodeError extends Data.TaggedError("AuditLogDecodeError")<{
  readonly id: string;
  readonly eventTag: string;
  readonly message: string;
}> {}

export interface AuditLogRecord {
  /** The event's own `eventId` (ESA-002) — a time-ordered id, and `replay`'s cursor. */
  readonly id: string;
  /** The stored tag: core's, or a plugin's (then `payload` is a `ForeignEvent`). */
  readonly eventTag: string;
  readonly actorUserId: Option.Option<UserId>;
  readonly occurredAt: DateTime.Utc;
  readonly correlationId: Option.Option<string>;
  readonly traceId: Option.Option<string>;
  readonly spanId: Option.Option<string>;
  readonly ip: Option.Option<string>;
  readonly userAgent: Option.Option<string>;
  /** The tenant the row was stamped with (BEH-EA-231); `None` for a single-tenant deployment or a historic row. */
  readonly tenantId: Option.Option<string>;
  /**
   * The decoded event (ESA-007) when core defines its tag; otherwise a `ForeignEvent` carrying the tag and
   * the stored fields (ADR-EA-049), which `payloadAs(definition)` decodes. Narrow on `payload._tag`.
   */
  readonly payload: AuthEvent | ForeignEvent;
}

/** ADR-EA-049: the event a record holds, as it was published: a `ForeignEvent` is unwrapped into its tag and fields. */
const eventOf = (payload: AuthEvent | ForeignEvent): EventDefinition.AnyEvent =>
  payload._tag === ForeignEventTag ? { ...payload.fields, _tag: payload.tag } : payload;

/** The delivered-event view of a stored row: the same `eventId`/`occurredAt` a live subscriber saw, a plugin's event unwrapped. */
export const toPublished = (record: AuditLogRecord): PublishedAny => ({
  ...eventOf(record.payload),
  eventId: record.id,
  occurredAt: record.occurredAt,
  correlationId: record.correlationId,
  traceId: record.traceId,
  spanId: record.spanId,
  ip: record.ip,
  userAgent: record.userAgent,
  tenantId: record.tenantId,
});

/**
 * ADR-EA-049: a plugin's own reading of a record. `Some` when the record holds an event of `definition`'s
 * tag that decodes with it (a `ForeignEvent`'s fields, or a core payload the definition accepts).
 */
export const payloadAs =
  <D extends EventDefinition.Any>(definition: D) =>
  (record: AuditLogRecord): Option.Option<EventDefinition.TypeOf<D>> => {
    if (record.eventTag !== definition[EventDefinition.MetaKey].tag) return Option.none();
    const { payload } = record;
    if (payload._tag === ForeignEventTag) {
      return Schema.decodeUnknownOption(definition)({ ...payload.fields, _tag: payload.tag });
    }
    return Schema.is(definition)(payload) ? Option.some(payload) : Option.none();
  };

export interface AuditLogListInput {
  readonly eventTag?: string;
  readonly actorUserId?: UserId;
  readonly occurredAfter?: DateTime.Utc;
  readonly occurredBefore?: DateTime.Utc;
}

export interface AuditLogReplayInput {
  /** Exclusive cursor: an `eventId`/row `id` the consumer has already handled. Omit to start at the beginning. */
  readonly after?: string;
  readonly eventTag?: string;
  /** Rows fetched per round trip; default 500. */
  readonly batchSize?: number;
}

export interface AuditLogShape {
  /**
   * Called by `AuthEvents` for every event, after it is stamped, before it is enqueued. A core event is
   * encoded with core's definition; any other with the definition given (ADR-EA-049), which also supplies
   * the actor column and the personal-data fields recorded with the row.
   */
  readonly record: {
    (event: Published): Effect.Effect<void, StoreUnavailable>;
    <D extends EventDefinition.Any>(
      event: Published<EventDefinition.TypeOf<D>>,
      definition: D,
    ): Effect.Effect<void, StoreUnavailable>;
  };
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
    readonly eventTags?: ReadonlyArray<string>;
    readonly exceptTags?: ReadonlyArray<string>;
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
      /** ADR-EA-049: the fields this event declared as personal data when it was written. */
      pii: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});
const decodeStoredMeta = Schema.decodeUnknownEffect(StoredMeta);

/**
 * ADR-EA-029/049: rows written before ADR-EA-049 carry no `meta.pii`. These three tags were the only ones
 * declaring personal data then, so erasure blanks these fields of such a row. Frozen: a later event records
 * its own `meta.pii`.
 */
export const PRE_ADR_049_PII: Readonly<Record<string, ReadonlyArray<string>>> = {
  "auth.admin.impersonationStarted": ["reason"],
  "auth.admin.userBanned": ["reason"],
  "auth.admin.organizationSuspended": ["reason"],
};

/** A JSON object (not an array, not `null`): the only shape a stored event may have. */
const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Event → the row `record` persists, through the event's own definition. Encoding keeps only the event's
 * own fields, so the envelope keys never leak into the payload. `meta.pii` is written only when the
 * definition declares personal data, so every other row is byte-identical to one written before ADR-EA-049.
 */
const toStoredRow = (published: PublishedAny, definition: EventDefinition.Any) =>
  Effect.gen(function* () {
    const encoded = yield* Effect.orDie(Schema.encodeUnknownEffect(definition)(published));
    if (!isJsonObject(encoded)) {
      return yield* Defects.invariantViolation(
        "AuditLog.record",
        `awthaq: the "${published._tag}" event does not encode as an object`,
      );
    }
    const meta = definition[EventDefinition.MetaKey];
    const row: AuditLogStore.AuditRow = {
      id: published.eventId,
      eventTag: published._tag,
      actorUserId: Option.map(EventDefinition.actorValue(meta, published), UserId),
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
          ...Option.match(published.spanId, {
            onNone: () => ({}),
            onSome: (spanId) => ({ spanId }),
          }),
          ...Option.match(published.ip, { onNone: () => ({}), onSome: (ip) => ({ ip }) }),
          ...Option.match(published.userAgent, {
            onNone: () => ({}),
            onSome: (userAgent) => ({ userAgent }),
          }),
          ...(meta.pii.length > 0 ? { pii: meta.pii } : {}),
        },
      }),
    };
    return row;
  });

/** The stored JSON text as a value, or `None` when it is not JSON at all. */
const parseJson = (text: string): Option.Option<unknown> => {
  try {
    const parsed: unknown = JSON.parse(text);
    return Option.some(parsed);
  } catch {
    return Option.none();
  }
};

/** ADR-EA-049: a row whose tag core does not define, carried opaquely: its stored fields, without the envelope keys. */
const foreignEvent = (tag: string, stored: Readonly<Record<string, unknown>>): ForeignEvent => ({
  _tag: ForeignEventTag,
  tag,
  fields: Object.fromEntries(
    Object.entries(stored).filter(([key]) => key !== "_tag" && key !== "version" && key !== "meta"),
  ),
});

const decodeRow = (
  row: AuditLogStore.AuditRow,
): Effect.Effect<AuditLogRecord, AuditLogDecodeError> =>
  Effect.gen(function* () {
    const failed = (error: unknown) =>
      new AuditLogDecodeError({
        id: row.id,
        eventTag: row.eventTag,
        message: `awthaq: audit row ${row.id} ("${row.eventTag}") does not decode: ${String(error)}`,
      });
    const parsed = parseJson(row.payloadJson);
    if (Option.isNone(parsed)) return yield* failed("the stored payload is not JSON");
    const stored = yield* decodeStoredMeta(parsed.value).pipe(Effect.mapError(failed));
    const payload = isEventTag(row.eventTag)
      ? yield* decodeEvent(upcastPayload(stored.version ?? 1, parsed.value)).pipe(
          Effect.mapError(failed),
        )
      : isJsonObject(parsed.value)
        ? foreignEvent(row.eventTag, parsed.value)
        : yield* failed("the stored payload is not a JSON object");
    return {
      id: row.id,
      eventTag: payload._tag === ForeignEventTag ? payload.tag : payload._tag,
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
 * ADR-EA-029/049: the fields of a stored row to blank on erasure: the `meta.pii` it was written with, or,
 * for a row written before ADR-EA-049, the frozen table plus core's own declaration. Reads no registry, so
 * a removed plugin's declared personal data is still blanked.
 */
const piiOfRow = (eventTag: string, payload: unknown): ReadonlyArray<string> =>
  Option.match(
    Option.flatMap(Schema.decodeUnknownOption(StoredMeta)(payload), (stored) =>
      Option.fromNullishOr(stored.meta?.pii),
    ),
    {
      onSome: (pii) => pii,
      onNone: () => [...(PRE_ADR_049_PII[eventTag] ?? []), ...piiFieldsOf(eventTag)],
    },
  );

/**
 * ESA-005: what erasing `userId` does to one row the store found referencing them. The alias is
 * substituted everywhere and the free-text fields (the row's declared personal data, `piiOfRow`) are
 * blanked. `None` when that changes nothing, so a rerun counts zero rows. Pure and total, because the
 * store applies it inside its own atomic unit; written once, so both adapters scrub identically.
 */
const scrubRow =
  (userId: string, alias: string) =>
  (row: AuditLogStore.AuditRow): Option.Option<AuditLogStore.AuditRewrite> => {
    const parsed = parseJson(row.payloadJson);
    const payloadJson = Option.match(parsed, {
      // Not JSON (a hand-edited row): all that can be done is to replace the id in the text.
      onNone: () => row.payloadJson.replaceAll(userId, alias),
      onSome: (payload) =>
        JSON.stringify(
          blankFields(replaceDeep(payload, userId, alias), piiOfRow(row.eventTag, payload)),
        ),
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

    // One implementation for both overloads: with no definition, the event is core's (it is typed
    // `Published`), so core's registry holds its definition.
    const record: AuditLogShape["record"] = (
      event: PublishedAny,
      definition?: EventDefinition.Any,
    ) =>
      Option.match(
        Option.orElse(Option.fromNullishOr(definition), () =>
          CoreRegistry.definitionOf(event._tag),
        ),
        {
          onNone: () =>
            Defects.invariantViolation(
              "AuditLog.record",
              `awthaq: no definition for the "${event._tag}" event`,
            ),
          onSome: (resolved) =>
            toStoredRow(event, resolved).pipe(
              Effect.flatMap(store.append),
              Effect.asVoid,
              relabel("AuditLog.record"),
            ),
        },
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
